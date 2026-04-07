import fs from "node:fs";
import path from "node:path";
import { listSessionFiles } from "./jsonlSessions.js";
import { ensureDir, writeJson } from "./fsx.js";
import type { Config } from "../types.js";

/**
 * 在改写会话 jsonl 之前，把当前会话目录下所有 .jsonl 复制到状态目录，
 * 便于「合并到最新会话」类操作后，仍能按文件名恢复接收合并的那份文件。
 */
export function snapshotSessionFilesBeforeRewrite(config: Config, dateKey: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destRoot = path.join(config.stateDir, "pre-refine-snapshots", dateKey, stamp);
  ensureDir(destRoot);
  const files = listSessionFiles(config.sessionsRoot);
  const copied: string[] = [];
  for (const filePath of files) {
    const base = path.basename(filePath);
    const dest = path.join(destRoot, base);
    fs.copyFileSync(filePath, dest);
    copied.push(base);
  }
  writeJson(path.join(destRoot, "_manifest.json"), {
    dateKey,
    createdAt: new Date().toISOString(),
    sessionsRoot: config.sessionsRoot,
    files: copied,
  });
  return destRoot;
}
