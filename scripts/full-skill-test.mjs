#!/usr/bin/env node
/**
 * memory-governor-pro / memory-lancedb-pro 单机验收脚本（单 agent 视角）
 *
 * 用法:
 *   node scripts/full-skill-test.mjs
 *   node scripts/full-skill-test.mjs --skip-api        # 不调 Jina/MiniMax
 *   node scripts/full-skill-test.mjs --skip-cli        # 不跑 openclaw memory-pro
 *   $env:OPENCLAW_HOME="C:\Users\xxx\.openclaw"; node scripts/full-skill-test.mjs
 *
 * 说明:
 * - 覆盖: openclaw.json 插件配置、LanceDB 连接与表结构、openclaw CLI(key 子命令)、
 *   可选的 Embedding/Rerank/LLM 连通性（需环境变量与 Key）。
 * - 不覆盖: 网关内 hook（agent_end 捕获、before_prompt_build 召回）、Agent 工具注册 —
 *   这些需在 OpenClaw 运行时另测。
 *
 * 退出码: 0 全部必测项通过；1 存在失败项。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const SKIP_API = args.has("--skip-api");
const SKIP_CLI = args.has("--skip-cli");

/** @type {{ name: string; status: 'PASS'|'FAIL'|'SKIP'|'WARN'; detail?: string }[]} */
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail: detail ? String(detail) : undefined });
  const line = `[${status}] ${name}${detail ? `: ${detail}` : ""}`;
  if (status === "FAIL") console.error(line);
  else if (status === "WARN") console.warn(line);
  else console.log(line);
}

function openclawHome() {
  const h = process.env.OPENCLAW_HOME?.trim();
  if (h) return path.normalize(h);
  return path.join(os.homedir(), ".openclaw");
}

/** 在未 export 的交互里，从 OPENCLAW_HOME/.env 补全变量（不覆盖已有 process.env） */
function loadDotenvUnsetOnly(dotenvPath) {
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

function resolveEnvPlaceholders(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k.trim()] ?? "");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${p}: ${e.message || e}`);
  }
}

function defaultPluginDbPath(home) {
  return path.join(home, "memory", "lancedb-pro");
}

function resolveGovDbPathTemplate(tpl, home, agentId) {
  const replaced = tpl
    .replaceAll("{OPENCLAW_HOME}", home)
    .replaceAll("{AGENT_ID}", agentId);
  return path.isAbsolute(replaced)
    ? path.normalize(replaced)
    : path.normalize(path.join(home, replaced));
}

function runOpenclaw(argv, openclawHome, extraEnv = {}) {
  const bin = process.env.OPENCLAW_BIN?.trim() || "openclaw";
  const cfgPath = path.join(openclawHome, "openclaw.json");
  const r = spawnSync(bin, argv, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      OPENCLAW_HOME: openclawHome,
      OPENCLAW_CONFIG_PATH: cfgPath,
      ...extraEnv,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

/** OpenClaw 顶层是否注册了插件提供的 memory-pro（部分版本仅有内置 openclaw memory，与本插件 CLI 不同） */
function openclawCliHasMemoryPro(home) {
  const h = runOpenclaw(["--help"], home);
  const out = `${h.stdout}\n${h.stderr}`;
  return /\bmemory-pro\b/m.test(out);
}

async function main() {
  console.log("=== memory-governor-pro / memory-lancedb-pro 验收 ===");
  console.log(`SKILL_ROOT=${SKILL_ROOT}`);
  console.log(`SKIP_API=${SKIP_API} SKIP_CLI=${SKIP_CLI}`);

  const home = openclawHome();
  record("OPENCLAW_HOME", "PASS", home);
  loadDotenvUnsetOnly(path.join(home, ".env"));

  const cfgPath = path.join(home, "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    record("openclaw.json", "FAIL", `不存在: ${cfgPath}`);
    printSummary(true);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = readJson(cfgPath);
    record("openclaw.json", "PASS", cfgPath);
  } catch (e) {
    record("openclaw.json", "FAIL", e.message || String(e));
    printSummary(true);
    process.exit(1);
  }

  const slot = cfg?.plugins?.slots?.memory;
  if (slot !== "memory-lancedb-pro") {
    record("plugins.slots.memory", "FAIL", `期望 memory-lancedb-pro，实际: ${slot}`);
  } else {
    record("plugins.slots.memory", "PASS", slot);
  }

  const entry = cfg?.plugins?.entries?.["memory-lancedb-pro"];
  if (!entry) {
    record("plugins.entries.memory-lancedb-pro", "FAIL", "缺少条目");
  } else if (entry.enabled === false) {
    record("plugins.entries.memory-lancedb-pro.enabled", "FAIL", "enabled 为 false");
  } else {
    record("plugins.entries.memory-lancedb-pro.enabled", "PASS", "true");
  }

  const pcfg = entry?.config || {};
  const dbPathConfigured = typeof pcfg.dbPath === "string" && pcfg.dbPath.trim().length > 0;
  const dbPath = dbPathConfigured
    ? path.normalize(resolveEnvPlaceholders(pcfg.dbPath.trim()))
    : defaultPluginDbPath(home);
  record("resolved dbPath", "PASS", dbPath);

  // Governor config 路径是否与插件一致（仅告警）
  const govCfgPath = path.join(SKILL_ROOT, "config.json");
  if (fs.existsSync(govCfgPath)) {
    try {
      const gov = readJson(govCfgPath);
      const gid = gov.agentId || "main";
      const govDb = resolveGovDbPathTemplate(gov?.lancedb?.dbPath || "", home, gid);
      const same =
        path.resolve(govDb).toLowerCase() === path.resolve(dbPath).toLowerCase();
      if (!same) {
        record(
          "governor vs plugin dbPath",
          "WARN",
          `governor config.json 指向 ${govDb}，插件解析为 ${dbPath} — nightly 可能与对话记忆不同库`,
        );
      } else {
        record("governor vs plugin dbPath", "PASS", "一致");
      }
    } catch (e) {
      record("governor config.json", "WARN", e.message || String(e));
    }
  } else {
    record("governor config.json", "SKIP", `无文件: ${govCfgPath}`);
  }

  // LanceDB
  const pkgJson = path.join(SKILL_ROOT, "package.json");
  if (!fs.existsSync(pkgJson)) {
    record("skill package.json", "FAIL", `不存在: ${pkgJson}`);
    printSummary(true);
    process.exit(1);
  }

  let lancedb;
  try {
    const req = createRequire(pkgJson);
    lancedb = req("@lancedb/lancedb");
    record("load @lancedb/lancedb", "PASS", "from skill node_modules");
  } catch (e) {
    record("load @lancedb/lancedb", "FAIL", e.message || String(e));
    printSummary(true);
    process.exit(1);
  }

  try {
    if (!fs.existsSync(dbPath)) {
      record("LanceDB 目录", "WARN", `不存在（首次运行可自动创建）: ${dbPath}`);
    }
    const db = await lancedb.connect(dbPath);
    const names = await db.tableNames();
    record("lancedb.connect + tableNames", "PASS", JSON.stringify(names));
    if (!names.includes("memories")) {
      record("表 memories", "FAIL", `当前表: ${names.join(", ") || "(空)"}`);
    } else {
      record("表 memories", "PASS", "存在");
      const table = await db.openTable("memories");
      const schema = await table.schema();
      const fields = schema.fields.map((f) => f.name);
      const required = [
        "id",
        "text",
        "vector",
        "category",
        "scope",
        "importance",
        "timestamp",
        "metadata",
      ];
      const missing = required.filter((r) => !fields.includes(r));
      if (missing.length) {
        record(
          "memories 列",
          "FAIL",
          `缺少列: ${missing.join(", ")}；现有: ${fields.join(", ")}`,
        );
      } else {
        record("memories 列", "PASS", fields.join(", "));
      }
      const dim = pcfg.embedding?.dimensions;
      if (typeof dim === "number" && dim > 0) {
        const rows = await table.query().limit(1).toArray();
        if (rows.length && Array.isArray(rows[0]?.vector)) {
          const vd = rows[0].vector.length;
          if (vd !== dim) {
            record(
              "向量维数 vs 配置",
              "FAIL",
              `表中样本维度=${vd}，openclaw.json embedding.dimensions=${dim}`,
            );
          } else {
            record("向量维数 vs 配置", "PASS", String(dim));
          }
        } else {
          record("向量维数 vs 配置", "SKIP", "表为空，无法抽样对比维度");
        }
      }
    }
  } catch (e) {
    record("LanceDB 检查", "FAIL", e.message || String(e));
  }

  // openclaw CLI
  if (!SKIP_CLI) {
    const ping = runOpenclaw(["--version"], home);
    if (ping.error || ping.status !== 0) {
      record(
        "openclaw CLI",
        "FAIL",
        ping.error?.message ||
          ping.stderr?.slice(0, 500) ||
          `exit=${ping.status}`,
      );
    } else {
      record("openclaw CLI", "PASS", (ping.stdout || "").trim().split("\n")[0] || "ok");
    }

    const val = runOpenclaw(["config", "validate"], home);
    if (val.status !== 0) {
      record(
        "openclaw config validate",
        "FAIL",
        val.stderr?.slice(0, 800) || val.stdout?.slice(0, 800) || `exit=${val.status}`,
      );
    } else {
      record("openclaw config validate", "PASS", (val.stdout || "").trim() || "ok");
    }

    const doc = runOpenclaw(["plugins", "doctor"], home);
    if (doc.status !== 0) {
      record(
        "openclaw plugins doctor",
        "WARN",
        doc.stderr?.slice(0, 1200) || doc.stdout?.slice(0, 1200) || `exit=${doc.status}`,
      );
    } else {
      record("openclaw plugins doctor", "PASS", "ok");
    }

    const hasMemPro = openclawCliHasMemoryPro(home);
    if (!hasMemPro) {
      record(
        "openclaw memory-pro 子命令",
        "SKIP",
        "当前 openclaw --help 中无 memory-pro（例如 2026.3.28 仅有内置 `openclaw memory`）。插件 CLI 由扩展注册，可能仅在部分构建/版本可用。LanceDB 直连检查已覆盖数据面。",
      );
    } else {
      const stats = runOpenclaw(["memory-pro", "stats"], home);
      if (stats.status !== 0) {
        record(
          "memory-pro stats",
          "FAIL",
          stats.stderr?.slice(0, 800) || stats.stdout?.slice(0, 800) || `exit=${stats.status}`,
        );
      } else {
        record("memory-pro stats", "PASS", "ok");
      }

      const lst = runOpenclaw(["memory-pro", "list", "--limit", "3"], home);
      if (lst.status !== 0) {
        record(
          "memory-pro list",
          "FAIL",
          lst.stderr?.slice(0, 800) || `exit=${lst.status}`,
        );
      } else {
        record("memory-pro list", "PASS", "ok");
      }

      const sr = runOpenclaw(["memory-pro", "search", "openclaw", "--limit", "2"], home);
      if (sr.status !== 0) {
        record(
          "memory-pro search",
          "FAIL",
          sr.stderr?.slice(0, 800) || `exit=${sr.status}`,
        );
      } else {
        record("memory-pro search", "PASS", "ok");
      }

      const mig = runOpenclaw(["memory-pro", "migrate", "check"], home);
      if (mig.status !== 0) {
        record(
          "memory-pro migrate check",
          "WARN",
          mig.stderr?.slice(0, 600) || mig.stdout?.slice(0, 600) || `exit=${mig.status}`,
        );
      } else {
        record("memory-pro migrate check", "PASS", "ok");
      }
    }

    const pins = runOpenclaw(["plugins", "inspect", "memory-lancedb-pro", "--json"], home);
    if (pins.status !== 0) {
      record(
        "plugins inspect memory-lancedb-pro",
        "SKIP",
        (pins.stderr || pins.stdout || "").trim().slice(0, 400) || `exit=${pins.status}`,
      );
    } else {
      record("plugins inspect memory-lancedb-pro", "PASS", "ok");
    }
  } else {
    record("openclaw CLI 子项", "SKIP", "--skip-cli");
  }

  // 远程 API（与 openclaw.json 一致）
  if (!SKIP_API) {
    const emb = pcfg.embedding || {};
    const baseURL = resolveEnvPlaceholders(emb.baseURL || "").replace(/\/$/, "");
    const apiKey = resolveEnvPlaceholders(
      Array.isArray(emb.apiKey) ? emb.apiKey[0] : emb.apiKey || "",
    );
    const model = emb.model || "text-embedding-3-small";

    if (!baseURL || !apiKey) {
      record(
        "Embedding API",
        "SKIP",
        "缺少 embedding.baseURL 或无法从环境解析 apiKey（${...}）",
      );
    } else {
      try {
        const url = `${baseURL}/embeddings`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: "memory-skill-test ping" }),
        });
        const text = await res.text();
        if (!res.ok) {
          record(
            "Embedding API",
            "FAIL",
            `HTTP ${res.status} ${text.slice(0, 400)}`,
          );
        } else {
          record("Embedding API", "PASS", `${url} HTTP ${res.status}`);
        }
      } catch (e) {
        record("Embedding API", "FAIL", e.message || String(e));
      }
    }

    const ret = pcfg.retrieval || {};
    const rUrl = resolveEnvPlaceholders(ret.rerankEndpoint || "").replace(/\/$/, "");
    const rKey = resolveEnvPlaceholders(ret.rerankApiKey || apiKey || "");
    const rModel = ret.rerankModel || "jina-reranker-v2-base-multilingual";
    if (!rUrl || !rKey) {
      record("Rerank API", "SKIP", "未配置 rerankEndpoint 或 rerankApiKey");
    } else {
      try {
        const res = await fetch(rUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${rKey}`,
          },
          body: JSON.stringify({
            model: rModel,
            query: "test",
            documents: ["a", "b"],
            top_n: 2,
          }),
        });
        const body = await res.text();
        if (!res.ok) {
          record(
            "Rerank API",
            "FAIL",
            `HTTP ${res.status} ${body.slice(0, 400)}`,
          );
        } else {
          record("Rerank API", "PASS", `HTTP ${res.status}`);
        }
      } catch (e) {
        record("Rerank API", "FAIL", e.message || String(e));
      }
    }

    const llm = pcfg.llm || {};
    const llmBase = resolveEnvPlaceholders(llm.baseURL || "").replace(/\/$/, "");
    const llmKey = resolveEnvPlaceholders(llm.apiKey || "");
    const llmModel = llm.model || "gpt-4o-mini";
    if (!llmBase || !llmKey) {
      record(
        "LLM API (smart extraction)",
        "SKIP",
        "未配置 llm 或无法解析 MINIMAX 等 apiKey",
      );
    } else {
      try {
        const url = `${llmBase}/chat/completions`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${llmKey}`,
          },
          body: JSON.stringify({
            model: llmModel,
            max_tokens: 8,
            messages: [{ role: "user", content: 'Reply only: OK' }],
          }),
        });
        const body = await res.text();
        if (!res.ok) {
          record(
            "LLM API (smart extraction)",
            "FAIL",
            `HTTP ${res.status} ${body.slice(0, 400)}`,
          );
        } else {
          record("LLM API (smart extraction)", "PASS", `${url} HTTP ${res.status}`);
        }
      } catch (e) {
        record("LLM API (smart extraction)", "FAIL", e.message || String(e));
      }
    }
  } else {
    record("Embedding/Rerank/LLM", "SKIP", "--skip-api");
  }

  const failed = results.filter((r) => r.status === "FAIL");
  printSummary(failed.length > 0);
  process.exit(failed.length > 0 ? 1 : 0);
}

function printSummary(hasFail) {
  console.log("\n=== 汇总 ===");
  const by = { PASS: [], FAIL: [], SKIP: [], WARN: [] };
  for (const r of results) by[r.status].push(r);
  console.log(
    JSON.stringify(
      {
        summary: {
          PASS: by.PASS.length,
          FAIL: by.FAIL.length,
          WARN: by.WARN.length,
          SKIP: by.SKIP.length,
          overall: hasFail ? "FAILED" : "OK",
        },
        failed: by.FAIL.map((x) => ({ name: x.name, reason: x.detail || "" })),
        warnings: by.WARN.map((x) => ({ name: x.name, detail: x.detail || "" })),
        skipped: by.SKIP.map((x) => ({ name: x.name, reason: x.detail || "" })),
      },
      null,
      2,
    ),
  );
  console.log(
    "\n未在此脚本验证（需网关运行）: agent_end 自动捕获、before_prompt_build 自动召回、",
    "各 memory_* / self_improvement_* 工具、memoryReflection sessionStrategy。",
  );
}

main().catch((e) => {
  console.error("未捕获异常:", e);
  process.exit(1);
});
