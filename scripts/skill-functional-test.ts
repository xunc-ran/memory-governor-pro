/**
 * 基于源码的 skill 功能探测（MemoryStore + 可选 Retriever + Governor rotateDay）
 *
 * 运行（在 skill 根目录）:
 *   npm run test:skill-functional
 *   或: node --import jiti/register scripts/skill-functional-test.ts
 *
 * 环境: OPENCLAW_HOME（默认 ~/.openclaw）；会读取 %OPENCLAW_HOME%/.env 补全变量。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Config as GovConfig } from "../src/types.js";
import { MemoryStore, validateStoragePath } from "../src/store.js";
import { createEmbedder, type EmbeddingConfig } from "../src/embedder.js";
import {
  createRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
} from "../src/retriever.js";
import { rotateDay } from "../src/lib/nightly.js";
import { createLogger } from "../src/lib/logger.js";
import { readJson, toDateKey, expandHome } from "../src/lib/fsx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

function step(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  const tag = ok ? "[PASS]" : "[FAIL]";
  if (ok) console.log(`${tag} ${name}: ${detail}`);
  else console.error(`${tag} ${name}: ${detail}`);
}

function loadDotenvUnsetOnly(dotenvPath: string) {
  if (!fs.existsSync(dotenvPath)) return;
  const text = fs.readFileSync(dotenvPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

function openclawHome(): string {
  const h = process.env.OPENCLAW_HOME?.trim();
  if (h) return path.normalize(expandHome(h));
  return path.join(os.homedir(), ".openclaw");
}

function resolveEnvPlaceholders(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k.trim()] ?? "");
}

function pseudoEmbedding(text: string, dimensions: number): number[] {
  const arr = Array.from({ length: dimensions }, () => 0);
  for (let i = 0; i < text.length; i++) {
    arr[i % dimensions] += text.charCodeAt(i) / 255;
  }
  return arr.map((v) =>
    Number((v / Math.max(1, text.length / dimensions)).toFixed(6)),
  );
}

function resolveGovRuntime(cfg: GovConfig): GovConfig {
  const openclawHomeDir = openclawHome();
  const agentId = process.env.OPENCLAW_AGENT_ID?.trim() || cfg.agentId || "main";
  const ctx = { openclawHome: openclawHomeDir, agentId };
  const resolveTpl = (input: string) =>
    (() => {
      const replaced = input
        .replaceAll("{OPENCLAW_HOME}", ctx.openclawHome)
        .replaceAll("{AGENT_ID}", ctx.agentId);
      const expanded = expandHome(replaced);
      return path.isAbsolute(expanded)
        ? path.normalize(expanded)
        : path.normalize(path.join(ctx.openclawHome, expanded));
    })();
  return {
    ...cfg,
    agentId,
    workspaceRoot: resolveTpl(cfg.workspaceRoot),
    sessionsRoot: resolveTpl(cfg.sessionsRoot),
    openclawConfigPath: resolveTpl(cfg.openclawConfigPath),
    stateDir: resolveTpl(cfg.stateDir),
    archiveRoot: resolveTpl(cfg.archiveRoot),
    selfImprovingRoot: resolveTpl(cfg.selfImprovingRoot),
    lancedb: {
      ...cfg.lancedb,
      dbPath: resolveTpl(cfg.lancedb.dbPath),
    },
  };
}

function pluginDbPath(
  home: string,
  pluginConfig: Record<string, unknown> | undefined,
): string {
  const raw = pluginConfig?.dbPath;
  if (typeof raw === "string" && raw.trim()) {
    return path.normalize(resolveEnvPlaceholders(raw.trim()));
  }
  return path.join(home, "memory", "lancedb-pro");
}

function pluginVectorDim(pluginConfig: Record<string, unknown> | undefined): number {
  const emb = pluginConfig?.embedding as Record<string, unknown> | undefined;
  const d = emb?.dimensions;
  return typeof d === "number" && d > 0 ? d : 1024;
}

function firstApiKey(
  key: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(key)) {
    const k = resolveEnvPlaceholders(key[0] || "");
    return k || undefined;
  }
  if (typeof key === "string") {
    const k = resolveEnvPlaceholders(key);
    return k || undefined;
  }
  return undefined;
}

function buildEmbeddingConfig(
  pluginConfig: Record<string, unknown> | undefined,
): EmbeddingConfig | null {
  if (!pluginConfig?.embedding || typeof pluginConfig.embedding !== "object") {
    return null;
  }
  const e = pluginConfig.embedding as Record<string, unknown>;
  const apiKey = firstApiKey(e.apiKey as string | string[] | undefined);
  if (!apiKey) return null;
  const provider = e.provider === "azure-openai" ? "azure-openai" : "openai-compatible";
  const baseURL =
    typeof e.baseURL === "string"
      ? resolveEnvPlaceholders(e.baseURL)
      : undefined;
  const model = typeof e.model === "string" ? e.model : "text-embedding-3-small";
  const dimensions =
    typeof e.dimensions === "number" ? e.dimensions : undefined;
  return {
    provider,
    apiKey,
    baseURL,
    model,
    dimensions,
    taskQuery: typeof e.taskQuery === "string" ? e.taskQuery : undefined,
    taskPassage: typeof e.taskPassage === "string" ? e.taskPassage : undefined,
    normalized: e.normalized === true,
    omitDimensions: e.omitDimensions === true,
    chunking: e.chunking !== false,
    apiVersion: typeof e.apiVersion === "string" ? e.apiVersion : undefined,
  };
}

function buildRetrieverPartial(
  pluginConfig: Record<string, unknown> | undefined,
): Partial<RetrievalConfig> {
  const r = pluginConfig?.retrieval as Record<string, unknown> | undefined;
  if (!r) return {};
  const out: Partial<RetrievalConfig> = {};
  if (r.mode === "hybrid" || r.mode === "vector") out.mode = r.mode;
  if (typeof r.vectorWeight === "number") out.vectorWeight = r.vectorWeight;
  if (typeof r.bm25Weight === "number") out.bm25Weight = r.bm25Weight;
  if (typeof r.minScore === "number") out.minScore = r.minScore;
  if (typeof r.candidatePoolSize === "number")
    out.candidatePoolSize = r.candidatePoolSize;
  if (typeof r.hardMinScore === "number") out.hardMinScore = r.hardMinScore;
  if (r.rerank === "cross-encoder" || r.rerank === "lightweight" || r.rerank === "none")
    out.rerank = r.rerank;
  if (typeof r.rerankApiKey === "string")
    out.rerankApiKey = resolveEnvPlaceholders(r.rerankApiKey);
  if (typeof r.rerankEndpoint === "string")
    out.rerankEndpoint = resolveEnvPlaceholders(r.rerankEndpoint);
  if (typeof r.rerankModel === "string") out.rerankModel = r.rerankModel;
  if (
    r.rerankProvider === "jina" ||
    r.rerankProvider === "siliconflow" ||
    r.rerankProvider === "voyage" ||
    r.rerankProvider === "pinecone" ||
    r.rerankProvider === "dashscope" ||
    r.rerankProvider === "tei"
  )
    out.rerankProvider = r.rerankProvider;
  return out;
}

async function main() {
  console.log("=== skill-functional-test（源码级能力）===\n");
  const home = openclawHome();
  loadDotenvUnsetOnly(path.join(home, ".env"));
  console.log(`OPENCLAW_HOME=${home}\n`);

  const cfgPath = path.join(home, "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    step("openclaw.json", false, `缺失: ${cfgPath}`);
    printSummary();
    process.exit(1);
  }

  const oc = readJson<Record<string, unknown>>(cfgPath, {});
  const plugin =
    (oc.plugins as Record<string, unknown> | undefined)?.entries as
      | Record<string, unknown>
      | undefined;
  const memEntry = plugin?.["memory-lancedb-pro"] as
    | Record<string, unknown>
    | undefined;
  const pconf = (memEntry?.config as Record<string, unknown> | undefined) ?? {};

  const dbPath = pluginDbPath(home, pconf);
  const dim = pluginVectorDim(pconf);
  const marker = `__fn_test_${Date.now()}__`;
  const testText = `${marker} OpenClaw memory-governor-pro 功能性写入测试`;

  let storedId: string | undefined;

  try {
    validateStoragePath(dbPath);
    step("validateStoragePath(dbPath)", true, dbPath);
  } catch (e: unknown) {
    step(
      "validateStoragePath(dbPath)",
      false,
      e instanceof Error ? e.message : String(e),
    );
    printSummary();
    process.exit(1);
  }

  const store = new MemoryStore({ dbPath, vectorDim: dim });
  const embCfg = buildEmbeddingConfig(pconf);
  let embedderForVector: ReturnType<typeof createEmbedder> | null = null;
  try {
    let vector: number[];
    if (embCfg) {
      embedderForVector = createEmbedder(embCfg);
      vector = await embedderForVector.embed(testText);
      if (vector.length !== dim) {
        throw new Error(
          `embed 维度=${vector.length} 与配置 dimensions=${dim} 不一致`,
        );
      }
    } else {
      vector = pseudoEmbedding(testText, dim);
    }
    const stored = await store.store({
      text: testText,
      vector,
      category: "fact",
      scope: "agent:functional-test",
      importance: 0.85,
      metadata: JSON.stringify({
        source: "skill-functional-test",
        marker,
      }),
    });
    storedId = stored.id;
    step(
      "MemoryStore.store",
      true,
      `id=${stored.id.slice(0, 8)}… vector=${embCfg ? "embedding API" : "pseudo"}`,
    );
  } catch (e: unknown) {
    step(
      "MemoryStore.store",
      false,
      e instanceof Error ? e.message : String(e),
    );
    printSummary();
    process.exit(1);
  }

  try {
    const got = await store.getById(storedId!, undefined);
    if (!got || !got.text.includes(marker)) {
      step(
        "MemoryStore.getById",
        false,
        got ? "内容不匹配 marker" : "未找到行",
      );
    } else {
      step("MemoryStore.getById", true, `scope=${got.scope}`);
    }
  } catch (e: unknown) {
    step(
      "MemoryStore.getById",
      false,
      e instanceof Error ? e.message : String(e),
    );
  }

  if (embCfg && embedderForVector) {
    try {
      const retriever = createRetriever(store, embedderForVector, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        ...buildRetrieverPartial(pconf),
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
        filterNoise: false,
      });
      const results = await retriever.retrieve({
        query: "功能性写入测试 OpenClaw",
        limit: 8,
        source: "cli",
      });
      const hit = results.some((r) => r.entry.id === storedId);
      step(
        "MemoryRetriever.retrieve（真实 embedder）",
        hit,
        hit
          ? `命中测试行，前条分数≈${results[0]?.score.toFixed(4) ?? "?"}`
          : `未在 top8 命中（可能阈值/索引/语义正常波动）；共 ${results.length} 条`,
      );
    } catch (e: unknown) {
      step(
        "MemoryRetriever.retrieve",
        false,
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    step(
      "MemoryRetriever.retrieve",
      true,
      "SKIP：无法解析 embedding.apiKey，仅测伪向量写入（检索需真实向量）",
    );
  }

  try {
    const del = await store.delete(storedId!, undefined);
    step("MemoryStore.delete", del, del ? "已删除测试行" : "delete 返回 false");
  } catch (e: unknown) {
    step(
      "MemoryStore.delete",
      false,
      e instanceof Error ? e.message : String(e),
    );
  }

  const govPath = path.join(SKILL_ROOT, "config.json");
  if (!fs.existsSync(govPath)) {
    step("Governor rotateDay", true, "SKIP：无 config.json");
  } else {
    const rawGov = readJson<GovConfig | null>(govPath, null);
    if (!rawGov) {
      step("Governor rotateDay", false, "config.json 解析失败");
    } else {
      const gov = resolveGovRuntime(rawGov);
      const logger = createLogger(gov.stateDir, `skill-fn-${Date.now()}`);
      /** 使用无会话的日期，只验证 rotateDay 聚合链路能跑通，避免 governor 的 lancedbStore 写入与主插件表结构冲突 */
      const dateKey = "1900-01-01";
      try {
        const rs = await rotateDay(gov, logger, dateKey, { skipDelete: true });
        const ok = rs.status === "no_data";
        step(
          "Governor rotateDay(skipDelete, 无会话日)",
          ok,
          JSON.stringify({
            status: rs.status,
            dateKey: rs.dateKey,
            note:
              "未测 refine+upsert：那会走 governor 独立库。若要对「今日会话」做端到端，请手动 npm run governor:nightly -- --date YYYY-MM-DD，且勿与插件共用 dbPath",
          }),
        );
      } catch (e: unknown) {
        step(
          "Governor rotateDay",
          false,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  console.log(
    "\n说明: 「精炼历史会话并删改/归档」由 Governor nightly（rotateDay）+ 磁盘上的 .jsonl 会话驱动，",
  );
  console.log(
    "不会在安装 memory-lancedb-pro 后自动执行；需任务计划/cron 执行 npm run governor:nightly，",
  );
  console.log(
    "且 governor 默认 dbPath 常为 lancedb-governor，与插件对话记忆库 lancedb-pro 可能不是同一目录。\n",
  );

  printSummary();
  const failed = steps.filter((s) => !s.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

function printSummary() {
  const failed = steps.filter((s) => !s.ok);
  console.log("\n=== 汇总 ===");
  console.log(
    JSON.stringify(
      {
        overall: failed.length === 0 ? "OK" : "FAILED",
        failed: failed.map((s) => ({ name: s.name, reason: s.detail })),
        steps: steps.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
