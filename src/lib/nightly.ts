import fs from "node:fs";
import path from "node:path";
import { aggregateByDate, listSessionFiles, rewriteRemoveDateFromFile, stableMemoryId } from "./jsonlSessions";
import { refineBucket } from "./refiner";
import { collectSelfImprovingRecords } from "./selfImprovingIngest";
import { upsertMemories } from "./lancedbStore";
import { upsertGovernanceStateFromRefined } from "./governance";
import { snapshotSessionFilesBeforeRewrite } from "./pre-refine-snapshot.js";
import { readJson, writeJson } from "./fsx";
import type { Config } from "../types";
import type { Logger } from "./logger";

function detectAgentOnlyDay(bucket: { messages: Array<{ role: string }> }): boolean {
  return !bucket.messages.some((m) => m.role === "user");
}

/** 防止在会话仍可能写入 jsonl 时对同一文件做 rewrite/归档 */
export interface RotateDaySafety {
  quietMsAfterSessionWrite: number;
  isSessionStemBusy: (stem: string) => boolean;
}

function pickLatestSessionFile(
  sessionsRoot: string,
  excludeFilePath: string,
): string | undefined {
  const candidates = listSessionFiles(sessionsRoot).filter(
    (p) => path.resolve(p) !== path.resolve(excludeFilePath),
  );
  if (candidates.length === 0) return undefined;
  let latest: string | undefined;
  let latestMtime = -1;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latest = p;
      }
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return latest;
}

function appendFileText(target: string, source: string): void {
  const text = fs.readFileSync(source, "utf8");
  if (!text.trim()) return;
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  fs.appendFileSync(target, normalized, "utf8");
}

export async function rotateDay(
  config: Config,
  logger: Logger,
  dateKey: string,
  opts: {
    skipDelete?: boolean;
    allowDelete?: boolean;
    safety?: RotateDaySafety;
    /** 跳过 safety（仅的内部调度 maxDefer 后与手工 --force-ignore-quiet） */
    forceIgnoreSafety?: boolean
  } = {},
) {
  const aggregated = await aggregateByDate(config.sessionsRoot, dateKey);
  const bucket = aggregated.find((x: any) => x.dateKey === dateKey);
  if (!bucket) return { status: "no_data", dateKey };

  if (opts.safety && !opts.forceIgnoreSafety) {
    const { quietMsAfterSessionWrite, isSessionStemBusy } = opts.safety;
    for (const filePath of bucket.sourceFiles as string[]) {
      const stem = path.basename(filePath, ".jsonl");
      if (isSessionStemBusy(stem)) {
        logger.warn("nightly.deferred_session_busy", { dateKey, sessionStem: stem });
        return { status: "deferred", dateKey, reason: "session_busy", sessionStem: stem };
      }
      try {
        const st = fs.statSync(filePath);
        const age = Date.now() - st.mtimeMs;
        if (age < quietMsAfterSessionWrite) {
          logger.warn("nightly.deferred_recent_write", { dateKey, filePath, ageMs: age });
          return { status: "deferred", dateKey, reason: "recent_session_write", filePath, ageMs: age };
        }
      } catch (err) {
        logger.warn("nightly.deferred_stat_failed", { dateKey, filePath, err: String(err) });
        return { status: "deferred", dateKey, reason: "stat_failed", filePath };
      }
    }
  }

  const selfRows = collectSelfImprovingRecords(config.selfImprovingRoot);
  const refined = refineBucket(bucket as any, selfRows).map((r: any, i: number) => ({
    ...r,
    id: stableMemoryId([config.agentId, r.date, r.type, String(i), r.summary]),
    agentId: config.agentId,
    createdAt: new Date().toISOString(),
    sessionIds: bucket.sourceSessionIds,
    agentOnlyDay: detectAgentOnlyDay(bucket),
  }));
  const upsertRs = await upsertMemories(config.lancedb, refined);
  upsertGovernanceStateFromRefined(config.stateDir, refined);
  logger.info("nightly.ingested", { dateKey, count: refined.length, storageMode: upsertRs.mode });
  writeJson(path.join(config.stateDir, "snapshots", `${dateKey}.json`), { dateKey, refined, sourceFiles: bucket.sourceFiles, upsertRs });
  if (opts.skipDelete) return { status: "ok_no_delete", dateKey, ingested: refined.length };

  let preRefineSnapshotDir: string | undefined;
  if (config.preRefineSessionSnapshot === true) {
    preRefineSnapshotDir = snapshotSessionFilesBeforeRewrite(config, dateKey);
    logger.info("nightly.pre_refine_snapshot", { dateKey, preRefineSnapshotDir });
  }

  const changes: any[] = [];
  for (const filePath of listSessionFiles(config.sessionsRoot)) {
    const rs = await rewriteRemoveDateFromFile(filePath, dateKey, config.archiveRoot);
    if (rs.onlyTargetDate) {
      if (config.rotation.allowPermanentDelete || opts.allowDelete) {
        fs.unlinkSync(filePath);
        fs.unlinkSync(rs.tmpPath);
        changes.push({ filePath, action: "deleted", archived: rs.archived });
      } else {
        fs.renameSync(rs.tmpPath, filePath);
        changes.push({ filePath, action: "rewritten_no_delete", archived: rs.archived });
      }
    } else {
      if (config.rotation.mergeRetainedIntoLatestSession) {
        const latest = pickLatestSessionFile(config.sessionsRoot, filePath);
        if (latest) {
          appendFileText(latest, rs.tmpPath);
          fs.unlinkSync(rs.tmpPath);
          fs.unlinkSync(filePath);
          changes.push({
            filePath,
            action: "migrated_retained_to_latest_session",
            retained: rs.retained,
            archived: rs.archived,
            targetSessionFile: latest,
          });
        } else {
          fs.renameSync(rs.tmpPath, filePath);
          changes.push({
            filePath,
            action: "rewritten_no_latest_session",
            retained: rs.retained,
            archived: rs.archived,
          });
        }
      } else {
        fs.renameSync(rs.tmpPath, filePath);
        changes.push({ filePath, action: "rewritten", retained: rs.retained, archived: rs.archived });
      }
    }
  }
  const st = readJson<{ rotatedDays: Record<string, any> }>(path.join(config.stateDir, "rotation-state.json"), { rotatedDays: {} });
  st.rotatedDays[dateKey] = {
    at: new Date().toISOString(),
    changes,
    ...(preRefineSnapshotDir ? { preRefineSnapshotDir } : {}),
  };
  writeJson(path.join(config.stateDir, "rotation-state.json"), st);
  return { status: "ok", dateKey, ingested: refined.length, changes };
}
