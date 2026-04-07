#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ensureDir, readJson, toDateKey } from "./lib/fsx";
import { createLogger } from "./lib/logger";
import { rotateDay } from "./lib/nightly";
import { applyGovernance } from "./lib/governance";
import { assertSingleInjector, buildInjectionPack, recordFlushEvent, shouldFlush } from "./lib/flushAndInject";
import { ensureSelfImprovingFiles, listVendoredCapabilities } from "./lib/vendor";
import { resolveRuntimeConfig } from "./lib/runtime-config.js";
import { todayYmdInTimeZone } from "./lib/daily-rotate.js";
import { maybePruneArchiveByRetention } from "./lib/archive-ttl.js";
import { runDailyRotatePipeline } from "./lib/daily-rotate.js";
import { governorIsSessionStemBusy } from "./lib/governor-session-activity.js";
import {
  assertValidDateKey,
  clearRotationDayRecord,
  inspectRotationDay,
  purgeGovernorMemoriesForDate,
  restoreSessionsFromArchive,
} from "./lib/audit-rollback.js";
import type { Config } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillRoot = path.resolve(__dirname, "..");
const configPath = path.join(skillRoot, "config.json");
const rawConfig = readJson<Config | null>(configPath, null);
if (!rawConfig) throw new Error(`未找到配置文件: ${configPath}`);

const config = resolveRuntimeConfig(rawConfig, { skillRoot });
ensureDir(config.stateDir);

const program = new Command();
const mkLogger = (k: string) => createLogger(config.stateDir, `${k}-${Date.now()}`);

program.name("memory-governor-pro").description("TS memory governance pipeline with vendored upstream projects");

program
  .command("daily-rotate")
  .description(
    "每日精炼：默认处理配置时区内「昨天」的会话日，并补跑未登记的历史日；可多 agent；归档后从 jsonl 移除该日消息并可删空文件",
  )
  .option("--date <YYYY-MM-DD>", "只处理指定日历日（必须早于今天）")
  .option("--agent <id>", "仅处理该 agent（与 --all-agents 互斥）")
  .option("--all-agents", "对 openclaw.json 中列出的全部 agent 各执行一遍", false)
  .option("--skip-catch-up", "不补跑仍含历史消息但 rotation-state 未登记的日期", false)
  .option("--catch-up-max-days <n>", "补跑时最多处理多少个待定日历日", "90")
  .option("--skip-delete", "仅精炼+归档+重写文件，不删除整份 jsonl（同 nightly --skipDelete）", false)
  .option(
    "--disallow-delete",
    "禁止在「仅含该日」时 unlink jsonl（不传入 allowDelete）",
    false,
  )
  .option(
    "--openclaw-cleanup",
    "若有成功 rotate，则执行 openclaw sessions cleanup --all-agents --enforce 同步会话索引",
    false,
  )
  .option("--openclaw-bin <path>", "openclaw 命令", "openclaw")
  .option("--force", "忽略 rotation-state，重复处理同一日历日（排错/补写入用）", false)
  .option(
    "--respect-session-activity",
    "会话忙或 jsonl 近期写入时推迟该日（与网关内调度相同门闸；独立脚本运行时 busy 仅 mtime 有效）",
    false,
  )
  .option("--force-ignore-quiet", "与 --respect-session-activity 同时使用时跳过推迟门闸", false)
  .action(async (opts) => {
    const isc = rawConfig.internalScheduler;
    const batch = await runDailyRotatePipeline(
      {
        rawConfig,
        singleAgentId: opts.agent as string | undefined,
        allAgents: Boolean(opts.allAgents),
        explicitDateKey: opts.date as string | undefined,
        catchUp: !opts.skipCatchUp,
        catchUpMaxDays: Number(opts.catchUpMaxDays) || 90,
        skipDelete: Boolean(opts.skipDelete),
        allowDelete: !opts.disallowDelete,
        openclawCleanup: Boolean(opts.openclawCleanup),
        openclawBin: (opts.openclawBin as string) || "openclaw",
        force: Boolean(opts.force),
        skillRoot,
        rotateSafety:
          opts.respectSessionActivity === true
            ? {
                quietMsAfterSessionWrite: isc?.quietMsAfterSessionWrite ?? 180_000,
                isSessionStemBusy: governorIsSessionStemBusy,
              }
            : undefined,
        forceIgnoreRotateSafety: opts.forceIgnoreQuiet === true,
      },
      (agentCfg, jobKey) => createLogger(agentCfg.stateDir, jobKey),
    );
    console.log(JSON.stringify({ ok: true, batch }, null, 2));
  });

program.command("nightly").option("--date <YYYY-MM-DD>").option("--skipDelete").option("--allowDelete").action(async (opts) => {
  const logger = mkLogger("nightly");
  const dateKey = opts.date || toDateKey(new Date());
  const rs = await rotateDay(config, logger, dateKey, { skipDelete: Boolean(opts.skipDelete), allowDelete: Boolean(opts.allowDelete) });
  console.log(JSON.stringify(rs, null, 2));
});

program.command("bootstrap").option("--days <n>", "90").option("--allowDelete").action(async (opts) => {
  const logger = mkLogger("bootstrap");
  const days = Number(opts.days);
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    await rotateDay(config, logger, toDateKey(d), { allowDelete: Boolean(opts.allowDelete && config.rotation.allowBootstrapDelete) });
  }
  console.log(JSON.stringify({ ok: true, days }, null, 2));
});

program.command("flush").requiredOption("--percent <n>").option("--query <text>", "近期决策与硬约束").action(async (opts) => {
  const logger = mkLogger("flush");
  assertSingleInjector(readJson<any>(config.openclawConfigPath, {}), logger);
  const singleThresholdPercent =
    config.contextFlush?.singleThresholdPercent ??
    Math.max(...(config.scheduler?.thresholds || [85]));
  const preemptMarginPercent = config.contextFlush?.preemptMarginPercent ?? 0;
  if (!shouldFlush(Number(opts.percent), singleThresholdPercent, preemptMarginPercent)) return;
  recordFlushEvent(config.stateDir, Number(opts.percent), "threshold");
  const rs = await buildInjectionPack(
    config,
    (opts.query as string) || config.contextFlush?.query || "近期决策与硬约束",
    logger,
  );
  console.log(JSON.stringify(rs, null, 2));
});

program.command("governance").option("--date <YYYY-MM-DD>").action(async (opts) => {
  const logger = mkLogger("governance");
  const rs = applyGovernance(config.stateDir, opts.date || toDateKey(new Date()), config.governance, logger);
  console.log(JSON.stringify(rs, null, 2));
});

program.command("vendor:status").action(() => {
  console.log(JSON.stringify(listVendoredCapabilities(skillRoot), null, 2));
});

program.command("vendor:init-self-improving").action(() => {
  const dir = ensureSelfImprovingFiles(config.workspaceRoot, skillRoot);
  console.log(JSON.stringify({ ok: true, learningsDir: dir }, null, 2));
});

program.command("build-pack").requiredOption("--query <text>").action(async (opts) => {
  const logger = mkLogger("pack");
  const rs = await buildInjectionPack(config, opts.query, logger);
  console.log(rs.payload);
});

function configForAgent(agentFlag: string | undefined): Config {
  const id = typeof agentFlag === "string" && agentFlag.trim() ? agentFlag.trim() : undefined;
  return resolveRuntimeConfig(rawConfig, { envAgentId: id, skillRoot });
}

program
  .command("audit-inspect")
  .description("只读核对：某日轮转台账、归档副本是否存在、精炼快照、调度锚点")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id（默认按环境/配置解析）")
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    assertValidDateKey(dateKey);
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const out = inspectRotationDay(cfg, dateKey);
    console.log(JSON.stringify(out, null, 2));
  });

program
  .command("audit-restore-sessions")
  .description("从归档副本按台账恢复会话 jsonl（可 dry-run；可选恢复「合并目标」会话文件）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只打印将执行的操作", false)
  .option("--skip-backup", "恢复前不备份当前文件", false)
  .option(
    "--restore-merge-targets",
    "若台账含「合并到最新会话」且存在改写前快照，则用快照中的文件覆盖 targetSessionFile",
    false,
  )
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = restoreSessionsFromArchive(cfg, dateKey, {
      dryRun: Boolean(opts.dryRun),
      backupCurrent: !opts.skipBackup,
      restoreMergeTargetsFromPreSnapshot: opts.restoreMergeTargets === true,
    });
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("audit-clear-rotation")
  .description("从 rotation-state 移除某日记录（便于恢复会话后按需重跑精炼；不删向量库）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只检查是否存在记录", false)
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = clearRotationDayRecord(cfg, dateKey, Boolean(opts.dryRun));
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("audit-purge-memories")
  .description("按 snapshots/<日>.json 中的精炼 id 从治理向量库删除，并 pruning governance-state（先 audit-inspect 核对）")
  .requiredOption("--date <YYYY-MM-DD>", "日历日")
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只列出将删除的 id", false)
  .action(async (opts) => {
    const dateKey = String(opts.date).trim();
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const rs = await purgeGovernorMemoriesForDate(cfg, dateKey, Boolean(opts.dryRun));
    console.log(JSON.stringify(rs, null, 2));
  });

program
  .command("archive-prune")
  .description(
    "按 archiveRetentionDays 删除归档根下过期日期子目录（YYYY-MM-DD）；未配置或 0 则跳过；默认以配置时区「今天」计算",
  )
  .option("--agent <id>", "智能体 id")
  .option("--dry-run", "只列出将删除的目录", false)
  .option("--force", "忽略「每日只跑一次」标记（可配合手工多次试跑）", false)
  .action(async (opts) => {
    const cfg = configForAgent(opts.agent as string | undefined);
    ensureDir(cfg.stateDir);
    const todayYmd = todayYmdInTimeZone(cfg.timezone || "UTC");
    const rs = maybePruneArchiveByRetention(cfg, todayYmd, {
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
    });
    console.log(JSON.stringify({ todayYmd, ...rs }, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

