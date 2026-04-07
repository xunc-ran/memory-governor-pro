import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fsx";
import {
  resolveBundledSelfImprovementRoot,
  resolveOpenclawPluginRoot,
} from "../self-improvement/bundled-resolve.js";

export function ensureSelfImprovingFiles(workspaceRoot: string, skillRoot: string) {
  const siRoot =
    resolveBundledSelfImprovementRoot(skillRoot) ??
    resolveBundledSelfImprovementRoot(path.join(skillRoot, "..")) ??
    resolveBundledSelfImprovementRoot(process.cwd());
  const sourceRoot = siRoot ? path.join(siRoot, "assets") : null;
  const targetRoot = path.join(workspaceRoot, ".learnings");
  ensureDir(targetRoot);
  for (const name of ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md", "SI_IMPLEMENTATION_AUDIT.md"]) {
    const target = path.join(targetRoot, name);
    if (!fs.existsSync(target)) {
      const source = sourceRoot ? path.join(sourceRoot, name) : null;
      if (source && fs.existsSync(source)) fs.copyFileSync(source, target);
      else fs.writeFileSync(target, `# ${name}\n\n`, "utf8");
    }
  }
  return targetRoot;
}

export function listVendoredCapabilities(skillRoot: string) {
  const pluginRoot =
    resolveOpenclawPluginRoot(skillRoot) ?? path.join(skillRoot, "upstream", "memory-lancedb-pro");
  const siRoot =
    resolveBundledSelfImprovementRoot(skillRoot) ??
    resolveBundledSelfImprovementRoot(pluginRoot) ??
    path.join(skillRoot, "upstream", "self-improving-agent");

  return {
    memoryLancedbPro: {
      present: fs.existsSync(path.join(pluginRoot, "openclaw.plugin.json")),
      path: pluginRoot,
      openclawPluginManifest: path.join(pluginRoot, "openclaw.plugin.json"),
      sourceEntry: path.join(pluginRoot, "index.ts"),
      bundledSelfImprovement: siRoot,
    },
    selfImproving: {
      present: fs.existsSync(path.join(siRoot, "SKILL.md")),
      path: siRoot,
      skillDoc: path.join(siRoot, "SKILL.md"),
      hooks: path.join(siRoot, "hooks", "openclaw"),
      scripts: path.join(siRoot, "scripts"),
      assets: path.join(siRoot, "assets"),
    },
  };
}

