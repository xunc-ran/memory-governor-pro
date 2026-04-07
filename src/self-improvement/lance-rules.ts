/**
 * Self-improvement rules: canonical store = LanceDB (metadata opencl_si_rule).
 * Markdown under .learnings/ is for implementation audit trails only.
 */

import type { MemoryStore, MemoryEntry } from "../store.js";
import {
  buildSmartMetadata,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "../smart-metadata.js";

export const OPENCL_SI_RULE = "opencl_si_rule" as const;

export type SiKind = "learning" | "error";
export type SiImplementationStatus =
  | "pending"
  | "implemented"
  | "wont_fix"
  | "promoted_to_skill";

function todayCompact(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export async function listSelfImprovementRules(
  store: MemoryStore,
  scopeFilter: string[] | undefined,
  maxScan = 3000,
): Promise<MemoryEntry[]> {
  const rows = await store.list(scopeFilter, undefined, maxScan, 0);
  const out: MemoryEntry[] = [];
  for (const e of rows) {
    const m = parseSmartMetadata(e.metadata, e);
    if (m[OPENCL_SI_RULE] === true) out.push(e);
  }
  return out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function nextSiHumanId(
  store: MemoryStore,
  scopeFilter: string[] | undefined,
  kind: SiKind,
): Promise<string> {
  const prefix = kind === "learning" ? "LRN" : "ERR";
  const date = todayCompact();
  const rules = await listSelfImprovementRules(store, scopeFilter, 5000);
  let max = 0;
  for (const e of rules) {
    const m = parseSmartMetadata(e.metadata, e);
    const hid = String(m.si_entry_id ?? "");
    const mm = hid.match(new RegExp(`^${prefix}-${date}-(\\d{3})$`));
    if (mm) max = Math.max(max, parseInt(mm[1], 10));
  }
  return `${prefix}-${date}-${String(max + 1).padStart(3, "0")}`;
}

export function buildSiRuleDocumentText(params: {
  humanId: string;
  kind: SiKind;
  summary: string;
  details: string;
  suggestedAction: string;
  category: string;
  area: string;
  priority: string;
  source: string;
  status: string;
}): string {
  return [
    `[${params.humanId}] ${params.kind} | ${params.category} | ${params.area} | ${params.priority} | status=${params.status}`,
    "",
    "### Summary",
    params.summary.trim(),
    "",
    "### Details",
    params.details.trim() || "-",
    "",
    "### Suggested action",
    params.suggestedAction.trim() || "-",
    "",
    "### Source",
    params.source,
  ].join("\n");
}

export interface StoreSelfImprovementRuleParams {
  store: MemoryStore;
  embedder: { embedPassage: (text: string) => Promise<number[]> };
  scope: string;
  scopeFilter: string[] | undefined;
  agentId: string;
  kind: SiKind;
  humanId: string;
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
}

export async function storeSelfImprovementRuleInLance(
  params: StoreSelfImprovementRuleParams,
): Promise<{ memoryId: string; entry: MemoryEntry }> {
  const {
    store,
    embedder,
    scope,
    scopeFilter,
    agentId,
    kind,
    humanId,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    status = "pending",
    source = "memory-lancedb-pro/self_improvement",
  } = params;

  const body = buildSiRuleDocumentText({
    humanId,
    kind,
    summary,
    details,
    suggestedAction,
    category,
    area,
    priority,
    source,
    status,
  });
  const vector = await embedder.embedPassage(body.slice(0, 8000));
  const meta = buildSmartMetadata(
    { text: summary, category: "other", importance: 0.72, timestamp: Date.now() },
    {
      state: "confirmed",
      memory_layer: "working",
      source: "manual",
      l0_abstract: summary.slice(0, 400),
      l1_overview: summary.slice(0, 800),
      l2_content: body,
      memory_category: "patterns",
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
      [OPENCL_SI_RULE]: true,
      si_entry_id: humanId,
      si_kind: kind,
      si_implementation_status: status as SiImplementationStatus,
      si_category: category,
      si_area: area,
      si_priority: priority,
      si_source: source,
      si_agent_id: agentId,
    },
  );

  const full = await store.store({
    text: body,
    vector,
    category: "other",
    scope,
    importance: 0.72,
    metadata: stringifySmartMetadata(meta),
  });

  return { memoryId: full.id, entry: full };
}

export async function findSelfImprovementRuleByHumanId(
  store: MemoryStore,
  scopeFilter: string[] | undefined,
  humanId: string,
): Promise<MemoryEntry | null> {
  const trimmed = humanId.trim();
  if (!trimmed) return null;
  const rules = await listSelfImprovementRules(store, scopeFilter, 8000);
  for (const e of rules) {
    const m = parseSmartMetadata(e.metadata, e);
    if (String(m.si_entry_id) === trimmed) return e;
  }
  return null;
}

export function summarizeSiRuleText(entry: MemoryEntry): string {
  const m = parseSmartMetadata(entry.metadata, entry);
  const fromMeta = String(m.l0_abstract || "").trim();
  if (fromMeta) return fromMeta;
  const sm = entry.text.match(/### Summary\n([\s\S]*?)\n###/m);
  return (sm?.[1] ?? entry.text.slice(0, 200)).trim();
}
