import { createHash } from "node:crypto";
import type { MemoryStore } from "../store.js";
import { buildSmartMetadata, stringifySmartMetadata } from "../smart-metadata.js";

/** Distinct metadata marker; also used to exclude this row from normal reflection listing if needed. */
export const SELF_IMPROVEMENT_REMINDER_KIND = "openclaw_self_improvement_reminder_v1";

export function selfImprovementReminderMemoryId(agentId: string): string {
  const aid = (agentId || "main").trim() || "main";
  return createHash("sha256")
    .update(`openclaw:self-improvement-reminder:v1|${aid}`)
    .digest("hex")
    .slice(0, 24);
}

export async function ensureSelfImprovementReminderRow(
  store: MemoryStore,
  embedder: { embedPassage: (text: string) => Promise<number[]> },
  params: {
    agentId: string;
    stableId: string;
    text: string;
    scope: string;
  },
): Promise<void> {
  if (await store.hasId(params.stableId)) return;
  const body = params.text.trim();
  if (!body) return;
  const clippedForEmbed = body.slice(0, 8000);
  const vector = await embedder.embedPassage(clippedForEmbed);
  const meta = buildSmartMetadata(
    {
      text: body,
      category: "preference",
      importance: 0.65,
      timestamp: Date.now(),
    },
    {
      state: "confirmed",
      memory_layer: "working",
      source: "manual",
      l0_abstract: body.slice(0, 480),
      l1_overview: body.slice(0, 1200),
      l2_content: body,
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
      opencl_reminder_kind: SELF_IMPROVEMENT_REMINDER_KIND,
    },
  );
  await store.importEntry({
    id: params.stableId,
    text: body,
    vector,
    category: "preference",
    scope: params.scope,
    importance: 0.65,
    timestamp: Date.now(),
    metadata: stringifySmartMetadata(meta),
  });
}

export async function loadSelfImprovementReminderTextFromStore(
  store: MemoryStore,
  embedder: { embedPassage: (text: string) => Promise<number[]> },
  params: {
    agentId: string;
    scopeFilter: string[] | undefined;
    defaultText: string;
    seedScope: string;
    onSeeded?: (line: string) => void;
  },
): Promise<string> {
  const stableId = selfImprovementReminderMemoryId(params.agentId);
  let row = await store.getById(stableId, params.scopeFilter);
  if (!row) {
    await ensureSelfImprovementReminderRow(store, embedder, {
      agentId: params.agentId,
      stableId,
      text: params.defaultText,
      scope: params.seedScope,
    });
    params.onSeeded?.(
      `self-improvement: seeded reminder in LanceDB id=${stableId.slice(0, 8)}… scope=${params.seedScope}`,
    );
    row = await store.getById(stableId, params.scopeFilter);
  }
  const t = row?.text?.trim();
  return t && t.length ? t : params.defaultText;
}
