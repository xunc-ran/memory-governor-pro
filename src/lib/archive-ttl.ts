import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ensureDir } from "./fsx.js";
import { addCalendarDaysYmd } from "./daily-rotate.js";
import { createLogger } from "./logger.js";
import type { Config } from "../types.js";

const YMD_DIR = /^\d{4}-\d{2}-\d{2}$/;

export interface ArchivePruneResult {
  /** 删除的日期子目录绝对路径 */
  deletedDirs: string[];
  /** 归档根下非 YYYY-MM-DD 名称，未删除仅记录 */
  skippedEntries: string[];
  /** 保留阈值：目录名 >= 此日则保留（早于此日的整体删除） */
  deleteBeforeYmd: string;
}

/**
 * 删除 archiveRoot 下名为 YYYY-MM-DD 且严格早于 deleteBeforeYmd 的子目录（整目录递归删除）。
 */
export function pruneExpiredArchiveDateDirs(
  archiveRoot: string,
  deleteBeforeYmd: string,
  dryRun: boolean,
): ArchivePruneResult {
  const deletedDirs: string[] = [];
  const skippedEntries: string[] = [];
  if (!fs.existsSync(archiveRoot)) {
    return { deletedDirs, skippedEntries, deleteBeforeYmd };
  }
  for (const name of fs.readdirSync(archiveRoot)) {
    const full = path.join(archiveRoot, name);
    if (!YMD_DIR.test(name)) {
      skippedEntries.push(name);
      continue;
    }
    if (name >= deleteBeforeYmd) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      skippedEntries.push(name);
      continue;
    }
    if (dryRun) {
      deletedDirs.push(full);
      continue;
    }
    fs.rmSync(full, { recursive: true, force: true });
    deletedDirs.push(full);
  }
  return { deletedDirs, skippedEntries, deleteBeforeYmd };
}

function archiveTtlMarkerPath(stateDir: string): string {
  return path.join(stateDir, "archive-ttl-last.json");
}

export interface MaybePruneArchiveResult {
  ran: boolean;
  reason?: string;
  result?: ArchivePruneResult;
}

/**
 * 按 config.archiveRetentionDays 清理过期归档；同一日历日每个 agent 最多执行一次（由 state 落盘控制）。
 */
export function maybePruneArchiveByRetention(
  config: Config,
  todayYmd: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): MaybePruneArchiveResult {
  const days = config.archiveRetentionDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    return { ran: false, reason: "disabled_or_invalid_retention" };
  }

  const markerPath = archiveTtlMarkerPath(config.stateDir);
  if (!opts.force && !opts.dryRun) {
    const last = readJson<{ lastPruneYmd?: string }>(markerPath, {});
    if (last.lastPruneYmd === todayYmd) {
      return { ran: false, reason: "already_pruned_today" };
    }
  }

  const deleteBeforeYmd = addCalendarDaysYmd(todayYmd, -Math.floor(days));
  const result = pruneExpiredArchiveDateDirs(config.archiveRoot, deleteBeforeYmd, opts.dryRun === true);

  if (!opts.dryRun) {
    ensureDir(config.stateDir);
    writeJson(markerPath, {
      lastPruneYmd: todayYmd,
      deleteBeforeYmd,
      deletedCount: result.deletedDirs.length,
      at: new Date().toISOString(),
    });
    try {
      createLogger(config.stateDir, `archive-ttl-${Date.now()}`).info("archive.pruned", {
        deleteBeforeYmd,
        deletedCount: result.deletedDirs.length,
        skippedNonDateDirs: result.skippedEntries.length,
      });
    } catch {
      /* ignore */
    }
  }

  return { ran: true, result };
}
