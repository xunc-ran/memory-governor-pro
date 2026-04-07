/**
 * 每日会话精炼：按日历日（配置时区）处理「已完成」的对话日，
 * 调用 rotateDay 精炼入库存档并从 transcript jsonl 中剔除该日消息。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { aggregateByDate } from "./jsonlSessions.js";
import { ensureDir, readJson } from "./fsx.js";
import { rotateDay } from "./nightly.js";
import { resolveRuntimeConfig } from "./runtime-config.js";
import type { Config } from "../types.js";
import type { Logger } from "./logger.js";

/** 在指定 IANA 时区下，将「此刻」对应的公历日格式化为 YYYY-MM-DD */
export function todayYmdInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d, 12, 0, 0);
  const dt = new Date(base + deltaDays * 86400000);
  const y2 = dt.getUTCFullYear();
  const m2 = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d2 = String(dt.getUTCDate()).padStart(2, "0");
  return `${y2}-${m2}-${d2}`;
}

export function yesterdayYmdInTimeZone(timeZone: string): string {
  return addCalendarDaysYmd(todayYmdInTimeZone(timeZone), -1);
}

export function readAgentIdsFromOpenclawConfig(
  openclawConfigPath: string,
  options: { skillRoot?: string } = {},
): string[] {
  if (!fs.existsSync(openclawConfigPath)) {
    return ["main"];
  }
  const cfg = readJson<Record<string, unknown>>(openclawConfigPath, {});
  const list = (cfg.agents as { list?: Array<{ id?: string }> } | undefined)
    ?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return ["main"];
  }
  const skillDirName = options.skillRoot ? path.basename(path.resolve(options.skillRoot)) : "";
  const defaultWorkspace =
    typeof (cfg.agents as any)?.defaults?.workspace === "string"
      ? String((cfg.agents as any).defaults.workspace).trim()
      : "";
  const ids = list
    .map((a) => {
      const id = typeof a?.id === "string" ? a.id.trim() : "";
      if (!id) return "";
      if (!skillDirName) return id;
      const workspaceRaw =
        typeof a?.workspace === "string" && a.workspace.trim()
          ? a.workspace.trim()
          : defaultWorkspace;
      if (!workspaceRaw) return "";
      const expected = path.resolve(workspaceRaw, "skills", skillDirName);
      return fs.existsSync(expected) ? id : "";
    })
    .filter(Boolean);
  return ids.length ? ids : ["main"];
}

/**
 * 会话 jsonl 中出现过的日历日，且早于 todayYmd、且未记入 rotation-state 的日期（升序，用于补跑）。
 */
export async function listPendingRotationDateKeys(
  config: Config,
  todayYmd: string,
  maxDays: number,
): Promise<string[]> {
  const buckets = await aggregateByDate(config.sessionsRoot, undefined);
  const fromFiles = new Set(buckets.map((b: { dateKey: string }) => b.dateKey));
  const statePath = path.join(config.stateDir, "rotation-state.json");
  const st = readJson<{ rotatedDays?: Record<string, unknown> }>(statePath, {
    rotatedDays: {},
  });
  const done = new Set(Object.keys(st.rotatedDays || {}));
  const pending = [...fromFiles].filter(
    (k) => k < todayYmd && !done.has(k) && /^\d{4}-\d{2}-\d{2}$/.test(k),
  );
  pending.sort();
  if (maxDays > 0 && pending.length > maxDays) {
    return pending.slice(0, maxDays);
  }
  return pending;
}

function runOpenclawSessionsCleanup(openclawBin: string, openclawHome: string) {
  const cfgPath = path.join(openclawHome, "openclaw.json");
  const r = spawnSync(
    openclawBin,
    ["sessions", "cleanup", "--all-agents", "--enforce"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_CONFIG_PATH: cfgPath,
      },
    },
  );
  return {
    ok: (r.status ?? 1) === 0,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function hasSessionMutation(results: unknown[]): boolean {
  for (const item of results as Array<any>) {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    for (const c of changes) {
      const action = typeof c?.action === "string" ? c.action : "";
      if (
        action === "deleted" ||
        action === "migrated_retained_to_latest_session" ||
        action.startsWith("rewritten")
      ) {
        return true;
      }
    }
  }
  return false;
}

function normalizeToSingleSessionFile(
  sessionsRoot: string,
): { keeperPath: string; mergedFrom: string[]; created: boolean } {
  ensureDir(sessionsRoot);
  const files = fs
    .readdirSync(sessionsRoot)
    .filter((x) => x.endsWith(".jsonl"))
    .map((x) => path.join(sessionsRoot, x));

  if (files.length === 0) {
    const keeperPath = path.join(sessionsRoot, `${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(keeperPath, "", "utf8");
    return { keeperPath, mergedFrom: [], created: true };
  }

  let keeperPath = files[0];
  let latestMtime = -1;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > latestMtime) {
        latestMtime = m;
        keeperPath = f;
      }
    } catch {
      /* ignore bad stat */
    }
  }

  const mergedFrom: string[] = [];
  for (const f of files) {
    if (path.resolve(f) === path.resolve(keeperPath)) continue;
    try {
      const text = fs.readFileSync(f, "utf8");
      if (text.trim()) {
        fs.appendFileSync(keeperPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      }
      fs.unlinkSync(f);
      mergedFrom.push(f);
    } catch {
      /* keep best-effort; do not fail pipeline */
    }
  }
  return { keeperPath, mergedFrom, created: false };
}

export interface DailyRotateOptions {
  rawConfig: Config;
  /** 若指定，仅此 agent（否则配合 allAgents） */
  singleAgentId?: string;
  allAgents: boolean;
  /** YYYY-MM-DD；不指定则用 yesterday（时区内） */
  explicitDateKey?: string;
  /** 额外补跑未完成的历史日（仍只处理 < 今天） */
  catchUp: boolean;
  catchUpMaxDays: number;
  skipDelete: boolean;
  /** 传给 rotateDay：为 true 时可在 allowPermanentDelete 为 false 时仍删除仅含该日的 jsonl */
  allowDelete: boolean;
  openclawCleanup: boolean;
  openclawBin: string;
  /** 若 rotation-state 已有该日记录仍再执行（默认 false，防计划任务重复跑写双份） */
  force: boolean;
  /** 当前 skill 根目录，用于判断 agent 是否安装了该 skill */
  skillRoot?: string;
  /** 网关心跳调度：会话忙/近期写入时推迟 rotate */
  rotateSafety?: {
    quietMsAfterSessionWrite: number;
    isSessionStemBusy: (stem: string) => boolean;
  };
  /** 跳过 rotateSafety（内部调度推迟过久或 CLI） */
  forceIgnoreRotateSafety?: boolean;
}

export async function runDailyRotatePipeline(
  options: DailyRotateOptions,
  mkLogger: (agentCfg: Config, jobKey: string) => Logger,
): Promise<
  Array<{
    agentId: string;
    dateKeys: string[];
    results: unknown[];
    openclawCleanup?: { ok: boolean; stderr: string };
    ensuredSingleSession?: { keeperPath: string; mergedFrom: string[]; created: boolean };
  }>
> {
  const tz = options.rawConfig.timezone || "UTC";
  const todayYmd = todayYmdInTimeZone(tz);
  const defaultYesterday = yesterdayYmdInTimeZone(tz);

  const agentIds: string[] = options.singleAgentId
    ? [options.singleAgentId.trim()]
    : options.allAgents
      ? readAgentIdsFromOpenclawConfig(
          resolveRuntimeConfig(options.rawConfig, { skillRoot: options.skillRoot }).openclawConfigPath,
          { skillRoot: options.skillRoot },
        )
      : [
          resolveRuntimeConfig(options.rawConfig, {
            skillRoot: options.skillRoot,
          }).agentId,
        ];

  const batchResults: Array<{
    agentId: string;
    dateKeys: string[];
    results: unknown[];
    openclawCleanup?: { ok: boolean; stderr: string };
    ensuredSingleSession?: { keeperPath: string; mergedFrom: string[]; created: boolean };
  }> = [];

  for (const agentId of agentIds) {
    const config = resolveRuntimeConfig(options.rawConfig, {
      envAgentId: agentId,
      skillRoot: options.skillRoot,
    });
    ensureDir(config.stateDir);
    ensureDir(path.join(config.stateDir, "snapshots"));
    const dateKeysSet = new Set<string>();
    if (options.explicitDateKey) {
      dateKeysSet.add(options.explicitDateKey.trim());
    } else {
      dateKeysSet.add(defaultYesterday);
    }
    if (options.catchUp) {
      const pending = await listPendingRotationDateKeys(
        config,
        todayYmd,
        options.catchUpMaxDays,
      );
      for (const k of pending) dateKeysSet.add(k);
    }

    const dateKeys = [...dateKeysSet].sort();
    const results: unknown[] = [];
    const logger = mkLogger(
      config,
      `daily-rotate-${agentId}-${Date.now()}`,
    );

    for (const dateKey of dateKeys) {
      if (dateKey >= todayYmd) {
        logger.warn("daily-rotate.skip_future_or_today", {
          dateKey,
          todayYmd,
          reason: "只处理已结束的日历日（早于今天）",
        });
        results.push({ dateKey, skipped: "today_or_future" });
        continue;
      }
      if (!options.force) {
        const stPath = path.join(config.stateDir, "rotation-state.json");
        const st = readJson<{ rotatedDays?: Record<string, { at?: string }> }>(
          stPath,
          { rotatedDays: {} },
        );
        if (st.rotatedDays?.[dateKey]) {
          logger.info("daily-rotate.skip_already_done", {
            dateKey,
            at: st.rotatedDays[dateKey].at,
          });
          results.push({
            dateKey,
            skipped: "already_rotated",
            previousAt: st.rotatedDays[dateKey].at,
          });
          continue;
        }
      }
      const rs = await rotateDay(config, logger, dateKey, {
        skipDelete: options.skipDelete,
        allowDelete: options.allowDelete,
        safety: options.rotateSafety,
        forceIgnoreSafety: options.forceIgnoreRotateSafety === true,
      });
      results.push(rs);
    }

    let openclawCleanup: { ok: boolean; stderr: string } | undefined;
    if (options.openclawCleanup && results.some((r: any) => r?.status === "ok")) {
      const home = path.dirname(config.openclawConfigPath);
      const cr = runOpenclawSessionsCleanup(options.openclawBin, home);
      openclawCleanup = { ok: cr.ok, stderr: cr.stderr.slice(0, 2000) };
    }
    let ensuredSingleSession:
      | { keeperPath: string; mergedFrom: string[]; created: boolean }
      | undefined;
    if (hasSessionMutation(results)) {
      ensuredSingleSession = normalizeToSingleSessionFile(config.sessionsRoot);
      logger.info("daily-rotate.normalize_single_session", {
        keeperPath: ensuredSingleSession.keeperPath,
        mergedFrom: ensuredSingleSession.mergedFrom,
        created: ensuredSingleSession.created,
      });
    }

    batchResults.push({
      agentId,
      dateKeys,
      results,
      openclawCleanup,
      ensuredSingleSession,
    });
  }

  return batchResults;
}
