import path from "node:path";
import fs from "node:fs";
import lockfile from "proper-lockfile";
import type { Config, InternalSchedulerConfig } from "../types.js";
import { resolveRuntimeConfig } from "./runtime-config.js";
import {
  listPendingRotationDateKeys,
  runDailyRotatePipeline,
  todayYmdInTimeZone,
  yesterdayYmdInTimeZone,
} from "./daily-rotate.js";
import { createLogger } from "./logger.js";
import { applyGovernance } from "./governance.js";
import { ensureDir, readJson, writeJson } from "./fsx.js";
import {
  governorIsSessionStemBusy,
  governorPruneStaleActivity,
} from "./governor-session-activity.js";
import { maybePruneArchiveByRetention } from "./archive-ttl.js";

export interface InternalGovernorSchedulerState {
  /** 已成功完成批跑后的锚点：至少应追到「配置时区下的昨夜」 */
  lastAnchorDateKey?: string;
  firstDeferIso?: string | null;
  lastTickIso?: string;
}

const DEFAULT_ISC: Required<
  Pick<
    InternalSchedulerConfig,
    | "runAtLocalTime"
    | "tickIntervalMs"
    | "jitterMaxMs"
    | "quietMsAfterSessionWrite"
    | "postTurnQuietMs"
    | "maxDeferMs"
    | "catchUpOutsideRunWindow"
    | "catchUpOnStartup"
    | "catchUpMaxDays"
    | "downtimeRecoveryMaxDays"
    | "lockStaleMs"
    | "runGovernanceAfterSuccess"
    | "openclawCleanup"
    | "openclawBin"
    | "firstInstallBackfillEnabled"
    | "firstInstallBackfillMaxDays"
  >
> = {
  runAtLocalTime: "00:05",
  tickIntervalMs: 60_000,
  jitterMaxMs: 90_000,
  quietMsAfterSessionWrite: 180_000,
  postTurnQuietMs: 120_000,
  maxDeferMs: 7_200_000,
  catchUpOutsideRunWindow: true,
  catchUpOnStartup: true,
  catchUpMaxDays: 7,
  downtimeRecoveryMaxDays: 365,
  lockStaleMs: 300_000,
  runGovernanceAfterSuccess: false,
  openclawCleanup: false,
  openclawBin: "openclaw",
  firstInstallBackfillEnabled: true,
  firstInstallBackfillMaxDays: 365,
};

function mergeIsc(raw?: InternalSchedulerConfig): typeof DEFAULT_ISC & InternalSchedulerConfig {
  return { ...DEFAULT_ISC, ...(raw || {}) };
}

function parseRunAtLocalMinutes(runAt: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(runAt.trim());
  if (!m) throw new Error(`internalScheduler.runAtLocalTime 无效: ${runAt}（须 HH:mm）`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`internalScheduler.runAtLocalTime 越界: ${runAt}`);
  }
  return hh * 60 + mm;
}

function localWallMinutesInTimeZone(timeZone: string, d = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomUInt(max: number): number {
  if (max <= 0) return 0;
  return Math.floor(Math.random() * (max + 1));
}

function schedulerStatePath(stateDir: string): string {
  return path.join(stateDir, "internal-scheduler-state.json");
}

function firstInstallBootstrapStatePath(stateDir: string): string {
  return path.join(stateDir, "first-install-bootstrap.json");
}

function isDeferredResult(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  return (r as { status?: string }).status === "deferred";
}

function batchHasDeferred(batch: Awaited<ReturnType<typeof runDailyRotatePipeline>>): boolean {
  for (const b of batch) {
    for (const r of b.results) {
      if (isDeferredResult(r)) return true;
    }
  }
  return false;
}

function batchHasSuccessfulRotate(batch: Awaited<ReturnType<typeof runDailyRotatePipeline>>): boolean {
  for (const b of batch) {
    for (const r of b.results) {
      if (r && typeof r === "object" && "status" in r) {
        const s = (r as { status?: string }).status;
        if (s === "ok" || s === "ok_no_delete") return true;
      }
    }
  }
  return false;
}

function daysDiffExclusive(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd, 12, 0, 0);
  const b = Date.UTC(ty, tm - 1, td, 12, 0, 0);
  const d = Math.floor((b - a) / 86_400_000);
  return Math.max(0, d);
}

/**
 * 网关进程内启动日终治理心跳；每个安装了本 skill 的 agent 由各自进程副本注册（安装路径决定 agentId）。
 */
export function startInternalGovernorScheduler(params: {
  skillRoot: string;
  rawConfig: Config;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): () => Promise<void> {
  const { skillRoot, rawConfig, log, warn } = params;

  if (process.env.MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER === "1") {
    log("memory-governor-pro: 内部调度已跳过（MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER=1）");
    return async () => {};
  }

  if (!rawConfig.internalScheduler || rawConfig.internalScheduler.enabled === false) {
    log("memory-governor-pro: 内部调度未启用（config.internalScheduler.enabled !== true）");
    return async () => {};
  }

  let stopRequested = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let firstInstallBackfillTried = false;
  /** 首帧：在 catchUpOnStartup 开启且仍有欠账时，允许未到 runAt 也尝试一轮 */
  let firstWake = mergeIsc(rawConfig.internalScheduler).catchUpOnStartup !== false;

  const tick = async (): Promise<void> => {
    if (stopRequested) return;

    const resolved = resolveRuntimeConfig(rawConfig, { skillRoot });
    const isc = mergeIsc(resolved.internalScheduler);
    const tz = resolved.timezone || "UTC";
    const todayYmd = todayYmdInTimeZone(tz);
    const intendedYesterday = yesterdayYmdInTimeZone(tz);
    const runAtMinutes = parseRunAtLocalMinutes(isc.runAtLocalTime);
    const nowMinutes = localWallMinutesInTimeZone(tz);
    const inMainWindow = nowMinutes >= runAtMinutes;

    ensureDir(resolved.stateDir);
    ensureDir(path.join(resolved.stateDir, ".locks"));
    governorPruneStaleActivity();

    if (!firstInstallBackfillTried && isc.firstInstallBackfillEnabled) {
      firstInstallBackfillTried = true;
      const markerPath = firstInstallBootstrapStatePath(resolved.stateDir);
      const marker = readJson<{
        done?: boolean;
        at?: string;
        note?: string;
      }>(markerPath, {});
      if (marker.done) {
        log(
          `memory-governor-pro: 首次安装回填已执行过（agent=${resolved.agentId}, at=${marker.at || "unknown"}）`,
        );
      } else {
        const firstLock = path.join(resolved.stateDir, ".locks", "governor-first-install-backfill");
        ensureDir(path.dirname(firstLock));
        if (!fs.existsSync(firstLock)) {
          fs.writeFileSync(firstLock, `${process.pid}\n`, "utf8");
        }
        let releaseFirst: (() => Promise<void>) | undefined;
        try {
          releaseFirst = await lockfile.lock(firstLock, {
            stale: isc.lockStaleMs,
            retries: { retries: 0 },
          });
        } catch {
          // other process is bootstrapping
        }
        if (releaseFirst) {
          try {
            log(
              `memory-governor-pro: 首次安装回填开始（agent=${resolved.agentId}, maxDays=${isc.firstInstallBackfillMaxDays}）`,
            );
            const firstBatch = await runDailyRotatePipeline(
              {
                rawConfig,
                singleAgentId: resolved.agentId,
                allAgents: false,
                explicitDateKey: undefined,
                catchUp: true,
                catchUpMaxDays:
                  isc.firstInstallBackfillMaxDays > 0
                    ? isc.firstInstallBackfillMaxDays
                    : Number.MAX_SAFE_INTEGER,
                skipDelete: false,
                allowDelete: true,
                openclawCleanup: isc.openclawCleanup === true,
                openclawBin: isc.openclawBin,
                force: false,
                skillRoot,
                rotateSafety: undefined,
                forceIgnoreRotateSafety: true,
              },
              (agentCfg, jobKey) => createLogger(agentCfg.stateDir, `${jobKey}-first-install`),
            );
            const hasDeferred = batchHasDeferred(firstBatch);
            if (!hasDeferred) {
              const processed = firstBatch.flatMap((b) => b.results).length;
              writeJson(markerPath, {
                done: true,
                at: new Date().toISOString(),
                note: `processed=${processed}`,
              });
              log(
                `memory-governor-pro: 首次安装回填完成（agent=${resolved.agentId}, processed=${processed}）`,
              );
            } else {
              writeJson(markerPath, {
                done: false,
                at: new Date().toISOString(),
                note: "deferred_found_will_retry_next_startup",
              });
              warn(
                `memory-governor-pro: 首次安装回填出现 deferred，已记录待重试（agent=${resolved.agentId}）`,
              );
            }
          } catch (e) {
            warn(`memory-governor-pro: 首次安装回填失败: ${String(e)}`);
          } finally {
            try {
              await releaseFirst();
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    const stPath = schedulerStatePath(resolved.stateDir);
    const persisted = readJson<InternalGovernorSchedulerState>(stPath, {});
    persisted.lastTickIso = new Date().toISOString();
    writeJson(stPath, persisted);

    try {
      const pr = maybePruneArchiveByRetention(resolved, todayYmd, {});
      if (pr.ran && pr.result && pr.result.deletedDirs.length > 0) {
        log(
          `memory-governor-pro: 归档 TTL 已清理 ${pr.result.deletedDirs.length} 个日期目录（早于 ${pr.result.deleteBeforeYmd}）`,
        );
      }
    } catch (e) {
      warn(`memory-governor-pro: 归档 TTL 清理失败: ${String(e)}`);
    }

    const anchorGapDays = persisted.lastAnchorDateKey
      ? daysDiffExclusive(persisted.lastAnchorDateKey, intendedYesterday)
      : 0;
    const recoveryCap =
      isc.downtimeRecoveryMaxDays > 0
        ? isc.downtimeRecoveryMaxDays
        : Number.MAX_SAFE_INTEGER;
    const dynamicCatchUpMaxDays = Math.max(
      isc.catchUpMaxDays,
      Math.min(anchorGapDays, recoveryCap),
    );

    let pending: string[] = [];
    try {
      pending = await listPendingRotationDateKeys(
        resolved,
        todayYmd,
        dynamicCatchUpMaxDays,
      );
    } catch (e) {
      warn(`memory-governor-pro: 列出待补跑日期失败: ${String(e)}`);
      return;
    }

    const needCatchUp = pending.length > 0;
    const anchorBehind =
      !persisted.lastAnchorDateKey ||
      persisted.lastAnchorDateKey < intendedYesterday;

    const fullyCaughtUp =
      !needCatchUp &&
      Boolean(persisted.lastAnchorDateKey) &&
      persisted.lastAnchorDateKey! >= intendedYesterday;

    if (fullyCaughtUp && !persisted.firstDeferIso) {
      return;
    }

    const allowCatchUpOutside = isc.catchUpOutsideRunWindow !== false;

    const startupPulse = firstWake && (needCatchUp || anchorBehind);
    if (firstWake) firstWake = false;
    if (startupPulse) {
      log(
        `memory-governor-pro: 启动补跑/校准 anchor=${persisted.lastAnchorDateKey ?? "(无)"} intendedYesterday=${intendedYesterday} pending=${pending.length} dynamicCatchUpMaxDays=${dynamicCatchUpMaxDays}`,
      );
    }

    const shouldRunNow =
      startupPulse ||
      (allowCatchUpOutside && needCatchUp) ||
      (inMainWindow && (needCatchUp || anchorBehind));

    if (!shouldRunNow) {
      return;
    }

    let forceIgnore =
      isc.maxDeferMs > 0 &&
      Boolean(persisted.firstDeferIso) &&
      Date.now() - new Date(persisted.firstDeferIso as string).getTime() >= isc.maxDeferMs;
    if (forceIgnore) {
      warn(
        `memory-governor-pro: 推迟已超过 maxDeferMs=${isc.maxDeferMs}ms，本轮强制忽略会话静默门闸`,
      );
    }

    const lockFile = path.join(resolved.stateDir, ".locks", "governor-internal-daily");
    ensureDir(path.dirname(lockFile));
    if (!fs.existsSync(lockFile)) {
      fs.writeFileSync(lockFile, `${process.pid}\n`, "utf8");
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(lockFile, {
        stale: isc.lockStaleMs,
        retries: { retries: 0 },
      });
    } catch {
      return;
    }

    try {
      await sleep(randomUInt(isc.jitterMaxMs));

      const rotateSafety =
        forceIgnore
          ? undefined
          : {
              quietMsAfterSessionWrite: isc.quietMsAfterSessionWrite,
              isSessionStemBusy: governorIsSessionStemBusy,
            };

      const batch = await runDailyRotatePipeline(
        {
          rawConfig,
          singleAgentId: resolved.agentId,
          allAgents: false,
          explicitDateKey: undefined,
          catchUp: true,
          catchUpMaxDays: dynamicCatchUpMaxDays,
          skipDelete: false,
          allowDelete: true,
          openclawCleanup: isc.openclawCleanup === true,
          openclawBin: isc.openclawBin,
          force: false,
          skillRoot,
          rotateSafety,
          forceIgnoreRotateSafety: forceIgnore,
        },
        (agentCfg, jobKey) => createLogger(agentCfg.stateDir, jobKey),
      );

      const deferred = batchHasDeferred(batch);
      if (deferred) {
        if (!persisted.firstDeferIso) {
          persisted.firstDeferIso = new Date().toISOString();
          writeJson(stPath, persisted);
        }
        warn("memory-governor-pro: 本轮因会话忙或近期写入推迟（deferred），将后续心跳重试");
        return;
      }

      persisted.firstDeferIso = null;
      const maxDateInBatch = batch.flatMap((b) => b.dateKeys).sort().pop();
      if (maxDateInBatch && maxDateInBatch >= intendedYesterday) {
        persisted.lastAnchorDateKey = maxDateInBatch;
      } else if (batchHasSuccessfulRotate(batch) || !needCatchUp) {
        persisted.lastAnchorDateKey = intendedYesterday;
      }
      writeJson(stPath, persisted);

      log(
        `memory-governor-pro: 内部调度 batch 完成 agent=${resolved.agentId} anchor=${persisted.lastAnchorDateKey}`,
      );

      if (isc.runGovernanceAfterSuccess) {
        const glog = createLogger(resolved.stateDir, `internal-gov-${Date.now()}`);
        try {
          applyGovernance(resolved.stateDir, todayYmd, resolved.governance, glog);
        } catch (e) {
          warn(`memory-governor-pro: applyGovernance 失败: ${String(e)}`);
        }
      }
    } catch (e) {
      warn(`memory-governor-pro: 内部调度执行失败: ${String(e)}`);
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          /* ignore */
        }
      }
    }
  };

  interval = setInterval(() => {
    void tick().catch((e) => warn(`memory-governor-pro: tick 异常: ${String(e)}`));
  }, mergeIsc(rawConfig.internalScheduler).tickIntervalMs);

  void tick().catch((e) => warn(`memory-governor-pro: 首 tick 异常: ${String(e)}`));

  log("memory-governor-pro: 内部日终调度已启动（随 OpenClaw 网关进程）");

  return async () => {
    stopRequested = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    log("memory-governor-pro: 内部日终调度已停止");
  };
}
