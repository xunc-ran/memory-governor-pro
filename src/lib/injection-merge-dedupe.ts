/**
 * Cross-source injection merge: ordered segments with semantic dedupe (Jaccard on tokens).
 * Used so auto-recall, reflection blocks, and self-improvement reminders do not repeat.
 */

export type InjectionPart = { source: string; text: string };

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#>\[\]\(\)\{\}\|:;,.!?/\\'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): Set<string> {
  const normalized = normalizeForDedupe(text);
  if (!normalized) return new Set<string>();
  return new Set(normalized.split(" ").filter((x) => x.length >= 2));
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/** Split on blank lines; keeps single-block XML blobs intact when no paragraph breaks. */
function paragraphsOf(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const chunks = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return chunks.length ? chunks : [t];
}

/**
 * Merge ordered injection parts: flatten paragraphs in order, drop paragraphs semantically
 * duplicative of any already kept paragraph (Jaccard >= threshold).
 */
export function mergeAndDedupeInjectionParts(
  parts: InjectionPart[],
  semanticThreshold: number,
  minTokenOverlap: number,
): { text: string; droppedParagraphs: number; keptSources: string[] } {
  const ordered: { source: string; paragraph: string }[] = [];
  for (const p of parts) {
    if (!p.text?.trim()) continue;
    for (const paragraph of paragraphsOf(p.text)) {
      ordered.push({ source: p.source, paragraph });
    }
  }

  const kept: string[] = [];
  const keptTokenSets: Set<string>[] = [];
  let droppedParagraphs = 0;

  for (const { paragraph } of ordered) {
    const tokens = tokenize(paragraph);
    if (tokens.size < minTokenOverlap) {
      kept.push(paragraph);
      keptTokenSets.push(tokens);
      continue;
    }
    let dup = false;
    for (const prev of keptTokenSets) {
      if (tokenJaccard(tokens, prev) >= semanticThreshold) {
        dup = true;
        break;
      }
    }
    if (dup) {
      droppedParagraphs++;
      continue;
    }
    kept.push(paragraph);
    keptTokenSets.push(tokens);
  }

  const keptSources = [...new Set(parts.map((p) => p.source).filter(Boolean))];
  return {
    text: kept.join("\n\n"),
    droppedParagraphs,
    keptSources,
  };
}
