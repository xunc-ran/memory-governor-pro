import path from "node:path";
import fs from "node:fs";
import { readJson } from "./fsx.js";
import type { Config, InternalSchedulerConfig } from "../types.js";

function deepMergeInternalScheduler(
  base: InternalSchedulerConfig | undefined,
  over: InternalSchedulerConfig | undefined,
): InternalSchedulerConfig | undefined {
  if (!over) return base;
  if (!base) return { ...over };
  return { ...base, ...over };
}

/**
 * 合并 openclaw.json 插件里的 governor 段与 skill 内 config.json（插件覆盖文件）。
 */
export function loadGovernorConfigMerged(skillRoot: string, pluginGovernor?: Record<string, unknown>): Config | null {
  const cfgPath = path.join(skillRoot, "config.json");
  if (!fs.existsSync(cfgPath)) return null;
  const fromFile = readJson<Config | null>(cfgPath, null);
  if (!fromFile) return null;

  if (!pluginGovernor || typeof pluginGovernor !== "object") {
    return fromFile;
  }

  const merged: Config = { ...fromFile };
  const iscRaw = pluginGovernor.internalScheduler;
  if (iscRaw && typeof iscRaw === "object" && !Array.isArray(iscRaw)) {
    merged.internalScheduler = deepMergeInternalScheduler(
      fromFile.internalScheduler,
      iscRaw as InternalSchedulerConfig,
    );
  }
  if (typeof pluginGovernor.preRefineSessionSnapshot === "boolean") {
    merged.preRefineSessionSnapshot = pluginGovernor.preRefineSessionSnapshot;
  }
  const ard = pluginGovernor.archiveRetentionDays;
  if (typeof ard === "number" && Number.isFinite(ard)) {
    merged.archiveRetentionDays = ard;
  }
  return merged;
}
