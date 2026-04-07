import { sanitize } from "./sanitize";

type Rule = { type: string; patterns: RegExp[] };
const TYPE_RULES: Rule[] = [
  { type: "preference", patterns: [/我喜欢|我不喜欢|偏好|always do|never do/i] },
  { type: "decision", patterns: [/决定|方案|we should|decide|定为/i] },
  { type: "todo", patterns: [/TODO|待办|next step|下一步|截止/i] },
  { type: "constraint", patterns: [/必须|only|禁止|单注入源|不可/i] },
  { type: "risk", patterns: [/风险|冲突|可能导致|danger/i] },
  { type: "fact", patterns: [/.*/] },
];

function detectType(text: string): string {
  for (const rule of TYPE_RULES) if (rule.patterns.some((p) => p.test(text))) return rule.type;
  return "fact";
}

function detectImportance(type: string, text: string): number {
  let score = 0.6;
  if (type === "constraint" || type === "decision") score += 0.2;
  if (/必须|critical|紧急|urgent|立即/i.test(text)) score += 0.15;
  if (text.length < 25) score -= 0.05;
  return Math.min(1, Math.max(0.1, Number(score.toFixed(2))));
}

function summarizeLine(text: string): string {
  const clean = sanitize(text.replace(/\s+/g, " ").trim());
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean;
}

export function refineBucket(
  bucket: { dateKey: string; messages: Array<{ text: string }>; sourceSessionIds: string[] },
  extraSources: Array<{ type?: string; summary?: string; text?: string; importance?: number; sourceKind?: string; tags?: string[] }> = [],
) {
  const units: Array<{
    type: string;
    summary: string;
    importance: number;
    date: string;
    sourceKind: string;
    sourceSessionIds: string[];
    tags: string[];
  }> = [];

  for (const msg of bucket.messages) {
    const summary = summarizeLine(msg.text || "");
    if (!summary) continue;
    const type = detectType(summary);
    units.push({
      type,
      summary,
      importance: detectImportance(type, summary),
      date: bucket.dateKey,
      sourceKind: "session",
      sourceSessionIds: bucket.sourceSessionIds,
      tags: [type],
    });
  }

  for (const src of extraSources) {
    units.push({
      type: src.type || "fact",
      summary: summarizeLine(src.summary || src.text || ""),
      importance: src.importance ?? 0.7,
      date: bucket.dateKey,
      sourceKind: src.sourceKind || "self_improving",
      sourceSessionIds: [],
      tags: src.tags || ["self_improving"],
    });
  }
  return units.filter((x) => x.summary);
}

