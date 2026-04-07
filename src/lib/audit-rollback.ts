import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ensureDir } from "./fsx.js";
import { deleteMemoryIds } from "./lancedbStore.js";
import { pruneGovernanceStateEntries } from "./governance.js";
import { createLogger } from "./logger.js";
import type { Config } from "../types.js";

function appendAudit(stateDir: string, event: string, data: Record<string, unknown>): void {
  try {
    createLogger(stateDir, `audit-rollback-${Date.now()}`).info(event, data);
  } catch {
    /* 留痕失败不阻断操作 */
  }
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RotationChangeEntry {
  filePath?: string;
  archived?: string;
  action?: string;
  targetSessionFile?: string;
  retained?: number;
}

export interface RotationDayRecord {
  at?: string;
  changes?: RotationChangeEntry[];
  /** 改写前快照目录（仅当配置开启 preRefineSessionSnapshot 时存在） */
  preRefineSnapshotDir?: string;
}

function rotationStatePath(stateDir: string): string {
  return path.join(stateDir, "rotation-state.json");
}

function schedulerStatePath(stateDir: string): string {
  return path.join(stateDir, "internal-scheduler-state.json");
}

function refinedSnapshotPath(stateDir: string, dateKey: string): string {
  return path.join(stateDir, "snapshots", `${dateKey}.json`);
}

export function assertValidDateKey(dateKey: string): void {
  if (!DATE_KEY_RE.test(dateKey.trim())) {
    throw new Error(`日期须为 YYYY-MM-DD：${dateKey}`);
  }
}

export function readRotationDayRecord(stateDir: string, dateKey: string): RotationDayRecord | null {
  const st = readJson<{ rotatedDays?: Record<string, RotationDayRecord> }>(
    rotationStatePath(stateDir),
    { rotatedDays: {} },
  );
  const rec = st.rotatedDays?.[dateKey];
  return rec && typeof rec === "object" ? rec : null;
}

/** 只读核对：轮转台账、归档文件是否存在、精炼快照、调度锚点等。 */
export function inspectRotationDay(config: Config, dateKey: string): Record<string, unknown> {
  assertValidDateKey(dateKey);
  const record = readRotationDayRecord(config.stateDir, dateKey);
  const refinedSnap = refinedSnapshotPath(config.stateDir, dateKey);
  const refinedExists = fs.existsSync(refinedSnap);

  let refinedIds: string[] = [];
  let refinedCount = 0;
  if (refinedExists) {
    const snap = readJson<{ refined?: Array<{ id?: string }> }>(refinedSnap, {});
    const refined = Array.isArray(snap.refined) ? snap.refined : [];
    refinedCount = refined.length;
    refinedIds = refined.map((r) => String(r?.id || "")).filter(Boolean);
  }

  const archiveChecks: Array<{
    archived?: string;
    exists: boolean;
    filePath?: string;
    action?: string;
  }> = [];

  if (record?.changes) {
    for (const ch of record.changes) {
      const archived = typeof ch.archived === "string" ? ch.archived : "";
      archiveChecks.push({
        filePath: ch.filePath,
        archived: archived || undefined,
        action: ch.action,
        exists: archived ? fs.existsSync(archived) : false,
      });
    }
  }

  let preRefineSnapshotDir = record?.preRefineSnapshotDir;
  const preRefineExists = Boolean(preRefineSnapshotDir && fs.existsSync(preRefineSnapshotDir));
  if (!preRefineExists) preRefineSnapshotDir = undefined;

  const sched = readJson<{ lastAnchorDateKey?: string }>(schedulerStatePath(config.stateDir), {});

  return {
    dateKey,
    agentId: config.agentId,
    hasRotationRecord: Boolean(record),
    rotatedAt: record?.at,
    changeCount: record?.changes?.length ?? 0,
    preRefineSnapshotDir: record?.preRefineSnapshotDir,
    preRefineSnapshotExists: preRefineExists,
    refinedSnapshotPath: refinedSnap,
    refinedSnapshotExists: refinedExists,
    refinedMemoryCount: refinedCount,
    refinedMemoryIds: refinedIds,
    archiveCopies: archiveChecks,
    schedulerLastAnchorDateKey: sched.lastAnchorDateKey,
  };
}

export interface RestoreSessionsResult {
  dateKey: string;
  dryRun: boolean;
  restored: Array<{ filePath: string; fromArchive: string; backedUp?: string }>;
  mergeTargetRestores: Array<{ targetSessionFile: string; fromPreSnapshot: string; backedUp?: string }>;
  skipped: Array<{ reason: string; detail?: Record<string, unknown> }>;
  warnings: string[];
}

/**
 * 用归档目录中的副本覆盖当前会话路径（按 rotation-state 中记录的变更）。
 * 可选：对「合并到最新会话」类操作，用改写前快照恢复 targetSessionFile。
 */
export function restoreSessionsFromArchive(
  config: Config,
  dateKey: string,
  opts: { dryRun: boolean; backupCurrent: boolean; restoreMergeTargetsFromPreSnapshot: boolean },
): RestoreSessionsResult {
  assertValidDateKey(dateKey);
  const record = readRotationDayRecord(config.stateDir, dateKey);
  if (!record?.changes?.length) {
    throw new Error(
      `未找到 ${dateKey} 的轮转记录或 changes 为空；无法从台账恢复（若仅归档无台账，请手工从归档目录复制）。`,
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const restored: RestoreSessionsResult["restored"] = [];
  const mergeTargetRestores: RestoreSessionsResult["mergeTargetRestores"] = [];
  const skipped: RestoreSessionsResult["skipped"] = [];
  const warnings: string[] = [];

  const seenTargets = new Set<string>();

  for (const ch of record.changes) {
    const filePath = typeof ch.filePath === "string" ? ch.filePath : "";
    const archived = typeof ch.archived === "string" ? ch.archived : "";
    const action = typeof ch.action === "string" ? ch.action : "";

    if (!filePath || !archived) {
      skipped.push({ reason: "缺少 filePath 或 archived", detail: { action } });
      continue;
    }
    if (!fs.existsSync(archived)) {
      skipped.push({ reason: "归档副本已不存在", detail: { filePath, archived } });
      continue;
    }

    if (opts.dryRun) {
      restored.push({ filePath, fromArchive: archived });
    } else {
      ensureDir(path.dirname(filePath));
      let backedUp: string | undefined;
      if (opts.backupCurrent && fs.existsSync(filePath)) {
        backedUp = `${filePath}.before-restore.${ts}`;
        fs.copyFileSync(filePath, backedUp);
      }
      fs.copyFileSync(archived, filePath);
      restored.push({ filePath, fromArchive: archived, backedUp });
    }

    if (
      opts.restoreMergeTargetsFromPreSnapshot &&
      action === "migrated_retained_to_latest_session" &&
      typeof ch.targetSessionFile === "string" &&
      record.preRefineSnapshotDir &&
      fs.existsSync(record.preRefineSnapshotDir)
    ) {
      const targetSessionFile = ch.targetSessionFile;
      const base = path.basename(targetSessionFile);
      const preSrc = path.join(record.preRefineSnapshotDir, base);
      if (!fs.existsSync(preSrc)) {
        warnings.push(`改写前快照中未找到合并目标对应文件：${base}（目录 ${record.preRefineSnapshotDir}）`);
      } else if (seenTargets.has(path.resolve(targetSessionFile))) {
        warnings.push(`跳过重复合并目标恢复：${targetSessionFile}`);
      } else {
        seenTargets.add(path.resolve(targetSessionFile));
        if (opts.dryRun) {
          mergeTargetRestores.push({ targetSessionFile, fromPreSnapshot: preSrc });
        } else {
          let backedUp: string | undefined;
          if (opts.backupCurrent && fs.existsSync(targetSessionFile)) {
            backedUp = `${targetSessionFile}.before-restore-merge-target.${ts}`;
            fs.copyFileSync(targetSessionFile, backedUp);
          }
          ensureDir(path.dirname(targetSessionFile));
          fs.copyFileSync(preSrc, targetSessionFile);
          mergeTargetRestores.push({ targetSessionFile, fromPreSnapshot: preSrc, backedUp });
        }
      }
    } else if (action === "migrated_retained_to_latest_session" && !opts.restoreMergeTargetsFromPreSnapshot) {
      warnings.push(
        `变更含「合并到最新会话」：已按归档恢复 ${filePath}；接收合并的文件 ${String(ch.targetSessionFile)} 未自动还原（请加 --restore-merge-targets）。`,
      );
    } else if (action === "migrated_retained_to_latest_session" && !record.preRefineSnapshotDir) {
      warnings.push(
        "当日台账未记录改写前快照目录；无法自动恢复合并目标文件（可在 config 中开启 preRefineSessionSnapshot 后重跑精炼）。",
      );
    }
  }

  if (!opts.dryRun && (restored.length > 0 || mergeTargetRestores.length > 0)) {
    appendAudit(config.stateDir, "audit.restore_sessions", {
      dateKey,
      restoredCount: restored.length,
      mergeTargetCount: mergeTargetRestores.length,
      skippedCount: skipped.length,
    });
  }

  return {
    dateKey,
    dryRun: opts.dryRun,
    restored,
    mergeTargetRestores,
    skipped,
    warnings,
  };
}

export function clearRotationDayRecord(
  config: Config,
  dateKey: string,
  dryRun: boolean,
): { dateKey: string; dryRun: boolean; removed: boolean; previousAt?: string } {
  assertValidDateKey(dateKey);
  const stPath = rotationStatePath(config.stateDir);
  const st = readJson<{ rotatedDays?: Record<string, RotationDayRecord> }>(stPath, { rotatedDays: {} });
  const prev = st.rotatedDays?.[dateKey];
  if (!prev) {
    return { dateKey, dryRun, removed: false };
  }
  if (dryRun) {
    return { dateKey, dryRun, removed: true, previousAt: prev.at };
  }
  delete st.rotatedDays![dateKey];
  writeJson(stPath, st);
  appendAudit(config.stateDir, "audit.rotation_record_cleared", { dateKey, previousAt: prev.at });
  return { dateKey, dryRun, removed: true, previousAt: prev.at };
}

export interface PurgeGovernorMemoriesResult {
  dateKey: string;
  dryRun: boolean;
  ids: string[];
  vectorDelete?: { mode: string; deleted: number };
  governancePruned: number;
}

/** 按当日精炼快照中的 id 从治理向量库删除，并 pruning governance-state.json。 */
export async function purgeGovernorMemoriesForDate(
  config: Config,
  dateKey: string,
  dryRun: boolean,
): Promise<PurgeGovernorMemoriesResult> {
  assertValidDateKey(dateKey);
  const snapPath = refinedSnapshotPath(config.stateDir, dateKey);
  if (!fs.existsSync(snapPath)) {
    throw new Error(`缺少精炼快照：${snapPath}；无法确定要删除的记忆 id。`);
  }
  const snap = readJson<{ refined?: Array<{ id?: string }> }>(snapPath, {});
  const refined = Array.isArray(snap.refined) ? snap.refined : [];
  const ids = [...new Set(refined.map((r) => String(r?.id || "").trim()).filter(Boolean))];
  if (!ids.length) {
    return { dateKey, dryRun, ids: [], governancePruned: 0 };
  }

  if (dryRun) {
    return { dateKey, dryRun, ids, governancePruned: 0 };
  }

  const vectorDelete = await deleteMemoryIds(config.lancedb, ids);
  const governancePruned = pruneGovernanceStateEntries(config.stateDir, ids);
  appendAudit(config.stateDir, "audit.governor_memories_purged", {
    dateKey,
    idCount: ids.length,
    vectorMode: vectorDelete.mode,
    vectorDeleted: vectorDelete.deleted,
    governancePruned,
  });
  return { dateKey, dryRun, ids, vectorDelete, governancePruned };
}
