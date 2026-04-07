import path from "node:path";
import { readJson, writeJson, fromDateKey } from "./fsx";
import type { Logger } from "./logger";

function diffDays(fromYmd: string, toYmd: string): number {
  const a = fromDateKey(fromYmd).getTime();
  const b = fromDateKey(toYmd).getTime();
  return Math.max(0, Math.floor((b - a) / (1000 * 3600 * 24)));
}

export function upsertGovernanceStateFromRefined(
  stateDir: string,
  refined: Array<{
    id: string;
    date: string;
    type?: string;
    summary?: string;
    importance?: number;
    agentOnlyDay?: boolean;
    agentId?: string;
  }>,
): void {
  const statePath = path.join(stateDir, "governance-state.json");
  const state = readJson<{ memories: Record<string, any> }>(statePath, { memories: {} });
  for (const m of refined) {
    if (!m?.id || !m?.date) continue;
    const existing = state.memories[m.id] || {};
    state.memories[m.id] = {
      ...existing,
      id: m.id,
      type: m.type || existing.type || "fact",
      summary: m.summary || existing.summary || "",
      importance:
        typeof m.importance === "number" && Number.isFinite(m.importance)
          ? m.importance
          : existing.importance ?? 0.7,
      agentId: m.agentId || existing.agentId || "main",
      lifecycle: existing.lifecycle || "hot",
      lastSeenDate: m.date,
      lastSeenAgentOnlyDay: m.agentOnlyDay === true,
      lastAgingCheckpointDate: existing.lastAgingCheckpointDate || m.date,
      agingEligibleDaysCount:
        typeof existing.agingEligibleDaysCount === "number"
          ? existing.agingEligibleDaysCount
          : 0,
      agingExcludedDaysCount:
        typeof existing.agingExcludedDaysCount === "number"
          ? existing.agingExcludedDaysCount
          : 0,
    };
  }
  writeJson(statePath, state);
}

export function applyGovernance(
  stateDir: string,
  dateKey: string,
  cfg: { hotDays: number; warmDays: number; retireDays: number; excludeAgentOnlyDayFromAging: boolean },
  logger: Logger,
) {
  const statePath = path.join(stateDir, "governance-state.json");
  const state = readJson<{ memories: Record<string, any> }>(statePath, { memories: {} });
  let retired = 0;
  let excludedDaysAdvanced = 0;
  let eligibleDaysAdvanced = 0;
  for (const rec of Object.values(state.memories) as Array<Record<string, any>>) {
    if (!rec.lastSeenDate) continue;

    const checkpoint =
      typeof rec.lastAgingCheckpointDate === "string" && rec.lastAgingCheckpointDate
        ? rec.lastAgingCheckpointDate
        : rec.lastSeenDate;
    const delta = diffDays(checkpoint, dateKey);
    if (delta > 0) {
      if (cfg.excludeAgentOnlyDayFromAging && rec.lastSeenAgentOnlyDay) {
        rec.agingExcludedDaysCount = (Number(rec.agingExcludedDaysCount) || 0) + delta;
        excludedDaysAdvanced += delta;
      } else {
        rec.agingEligibleDaysCount = (Number(rec.agingEligibleDaysCount) || 0) + delta;
        eligibleDaysAdvanced += delta;
      }
      rec.lastAgingCheckpointDate = dateKey;
    }

    const ageDays =
      Number.isFinite(Number(rec.agingEligibleDaysCount))
        ? Number(rec.agingEligibleDaysCount)
        : diffDays(rec.lastSeenDate, dateKey);
    if (ageDays >= cfg.retireDays) { rec.lifecycle = "retired"; retired++; }
    else if (ageDays >= cfg.warmDays) rec.lifecycle = "cold";
    else if (ageDays >= cfg.hotDays) rec.lifecycle = "warm";
    else rec.lifecycle = "hot";
  }
  writeJson(statePath, state);
  logger.info("governance.applied", {
    dateKey,
    retired,
    memoryCount: Object.keys(state.memories).length,
    eligibleDaysAdvanced,
    excludedDaysAdvanced,
  });
  return { retired };
}

/** 从治理状态台账中移除指定记忆 id（用于回滚「某日精炼」后对齐元数据）。 */
export function pruneGovernanceStateEntries(stateDir: string, ids: string[]): number {
  if (!ids.length) return 0;
  const statePath = path.join(stateDir, "governance-state.json");
  const state = readJson<{ memories: Record<string, unknown> }>(statePath, { memories: {} });
  let removed = 0;
  for (const id of ids) {
    if (id && state.memories[id] !== undefined) {
      delete state.memories[id];
      removed++;
    }
  }
  if (removed > 0) writeJson(statePath, state);
  return removed;
}

