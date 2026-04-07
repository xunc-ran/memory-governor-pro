import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, toDateKey } from "./fsx";
import { queryMemories } from "./lancedbStore";
import { toToonBlock } from "./toon";
import type { Logger } from "./logger";

export function assertSingleInjector(openclawConfig: any, logger: Logger): string[] {
  const plugins = openclawConfig?.plugins?.entries || {};
  const enabled = Object.entries(plugins).filter(([, v]: any) => v?.enabled).map(([k]) => k);
  const memoryInjectors = enabled.filter((name) => /memory|lancedb|recall/i.test(name));
  if (memoryInjectors.length > 1) {
    logger.error("injector.violation", { memoryInjectors });
    throw new Error(`检测到多个记忆注入源: ${memoryInjectors.join(", ")}`);
  }
  return memoryInjectors;
}

export function shouldFlush(
  percent: number,
  singleThresholdPercent: number,
  preemptMarginPercent = 0,
): boolean {
  const triggerLine = Number(singleThresholdPercent) - Number(preemptMarginPercent || 0);
  return Number(percent) >= triggerLine;
}

export async function buildInjectionPack(config: any, query: string, logger: Logger) {
  const rows = await queryMemories(
    config.lancedb,
    query,
    config.injection.topK,
    typeof config.agentId === "string" ? config.agentId : "main",
  );
  const shortRows = rows.map((r: any) => ({
    type: r.type || "fact",
    summary: String(r.summary || "").slice(0, 220),
    date: r.date || "",
    tags: r.tags || [],
  }));
  const toon = toToonBlock(shortRows);
  const payload = toon.length <= config.injection.maxChars ? toon : JSON.stringify(shortRows);
  const outPath = path.join(config.stateDir, "context-pack.md");
  fs.writeFileSync(outPath, payload, "utf8");
  writeJson(path.join(config.stateDir, "context-pack.meta.json"), {
    at: new Date().toISOString(),
    count: shortRows.length,
    format: payload.startsWith("memories@v1{") ? "toon" : "json",
  });
  logger.info("inject.pack_built", { outPath, rows: shortRows.length });
  return { outPath, rows: shortRows.length, payload };
}

export function recordFlushEvent(stateDir: string, percent: number, reason: string): void {
  const file = path.join(stateDir, "flush-events.json");
  const st = readJson<{ events: any[] }>(file, { events: [] });
  st.events.push({ at: new Date().toISOString(), date: toDateKey(new Date()), percent, reason });
  writeJson(file, st);
}

