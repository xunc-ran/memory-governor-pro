/**
 * Locate the vendored self-improvement skill (scripts, SKILL.md, hooks, assets)
 * shipped inside memory-lancedb-pro. Supports multiple on-disk layouts.
 */

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const _here = dirname(fileURLToPath(import.meta.url));

/** Directory containing this file: `src/self-improvement` */
export const SELF_IMPROVEMENT_MODULE_DIR = _here;

/** memory-lancedb-pro package root (parent of `src/`, contains `bundled/`, `index.ts`). */
export const PLUGIN_PACKAGE_ROOT = join(_here, "..", "..");

const RELATIVE_SELF_IMPROVEMENT_ROOTS = [
  join("bundled", "self-improvement"),
  "self-improving-agent",
  join("upstream", "self-improving-agent"),
] as const;

export function resolveBundledSelfImprovementRoot(searchBase: string): string | undefined {
  for (const rel of RELATIVE_SELF_IMPROVEMENT_ROOTS) {
    const p = join(searchBase, rel);
    if (fs.existsSync(join(p, "SKILL.md"))) return p;
  }
  return undefined;
}

/** OpenClaw plugin root: current package or `upstream/memory-lancedb-pro`. */
export function resolveOpenclawPluginRoot(searchBase: string): string | undefined {
  if (fs.existsSync(join(searchBase, "openclaw.plugin.json"))) return searchBase;
  const nested = join(searchBase, "upstream", "memory-lancedb-pro");
  if (fs.existsSync(join(nested, "openclaw.plugin.json"))) return nested;
  return undefined;
}

export async function readBundledSelfImprovementAsset(
  assetFileName: string,
  searchBase: string = PLUGIN_PACKAGE_ROOT,
): Promise<string | undefined> {
  const root = resolveBundledSelfImprovementRoot(searchBase);
  if (!root) return undefined;
  const full = join(root, "assets", assetFileName);
  try {
    return await readFile(full, "utf-8");
  } catch {
    return undefined;
  }
}
