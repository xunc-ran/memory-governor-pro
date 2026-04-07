import fs from "node:fs";
import path from "node:path";

export function collectSelfImprovingRecords(rootDir: string) {
  const files = [
    path.join(rootDir, ".learnings", "LEARNINGS.md"),
    path.join(rootDir, ".learnings", "ERRORS.md"),
    path.join(rootDir, ".learnings", "FEATURE_REQUESTS.md"),
  ];
  const rows: Array<{ sourceKind: string; type: string; summary: string; importance: number; tags: string[] }> = [];
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const chunks = content.split(/\n##\s+/).map((c, i) => (i === 0 ? c : `## ${c}`));
    for (const chunk of chunks) {
      const normalized = chunk.replace(/\s+/g, " ").trim();
      if (!normalized.startsWith("## [")) continue;
      rows.push({
        sourceKind: "self_improving",
        type: "rule",
        summary: normalized.slice(0, 180),
        importance: /critical|high/i.test(normalized) ? 0.9 : 0.75,
        tags: ["self_improving"],
      });
    }
  }
  return rows;
}

