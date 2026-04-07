function esc(v: string): string {
  return String(v).replace(/\n/g, " ").replace(/\|/g, "/").trim();
}

export function toToonBlock(items: Array<{ type: string; summary: string; date: string; tags: string[] }>): string {
  const rows = items.map((it, idx) => `  [${idx + 1}|${esc(it.type)}|${esc(it.summary)}|${esc(it.date)}|${esc((it.tags || []).join(","))}]`);
  return `memories@v1{\n${rows.join("\n")}\n}`;
}

