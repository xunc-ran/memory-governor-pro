/**
 * OpenClaw 网关内建的日终治理调度（无需系统 cron/计划任务）。
 * 路径与 agent 解析仍由 resolveRuntimeConfig + OPENCLAW_HOME 保证跨环境一致。
 */
export interface InternalSchedulerConfig {
  /** 为 true 时随 OpenClaw 网关 registerService 启动；可用 MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER=1 关闭 */
  enabled?: boolean;
  /** 在 config.timezone 下，本地墙钟何时允许跑「昨夜」主任务，格式 HH:mm（24h）。默认 00:05，略晚于 0 点减少边界竞态 */
  runAtLocalTime?: string;
  /** 心跳间隔（毫秒） */
  tickIntervalMs?: number;
  /** 触发前随机等待 [0, jitterMaxMs]，缓和多实例同时抢锁 */
  jitterMaxMs?: number;
  /** 会话 jsonl 的 mtime 距离现在不足该毫秒则推迟 rotate（防并发写入） */
  quietMsAfterSessionWrite?: number;
  /** agent_end 之后仍视为「可能还有异步落盘」的静默窗口（毫秒） */
  postTurnQuietMs?: number;
  /**
   * 已推迟超过该毫秒后，强制忽略 quiet/busy 仍执行 rotate（0 = 永不强制）。
   * 防止永远 defer 导致日终不跑。
   */
  maxDeferMs?: number;
  /** 网关心跳内是否允许在 runAt 窗口外补跑历史欠账（默认 true） */
  catchUpOutsideRunWindow?: boolean;
  /** 启动后尽快补跑 rotation-state 欠账 */
  catchUpOnStartup?: boolean;
  catchUpMaxDays?: number;
  /**
   * 网关停机恢复：根据 lastAnchorDateKey 到 yesterday 的缺口自动放大补跑上限（天）。
   * 0 表示不限制（仍受数据实际存在约束）。
   */
  downtimeRecoveryMaxDays?: number;
  /** proper-lockfile stale（毫秒） */
  lockStaleMs?: number;
  /** 本轮 batch 全部成功（无 deferred）后是否再跑 applyGovernance */
  runGovernanceAfterSuccess?: boolean;
  openclawCleanup?: boolean;
  openclawBin?: string;
  /** 首次安装该 skill 到当前 agent 后，启动时自动回填历史会话 */
  firstInstallBackfillEnabled?: boolean;
  /** 首次自动回填最多处理多少历史日（0 表示不限） */
  firstInstallBackfillMaxDays?: number;
}

export interface Config {
  agentId: string;
  timezone: string;
  workspaceRoot: string;
  sessionsRoot: string;
  openclawConfigPath: string;
  stateDir: string;
  archiveRoot: string;
  /**
   * 会话归档目录（archiveRoot 下按 YYYY-MM-DD 分的子目录）保留天数。
   * 在配置时区下，删除「日历日严格早于 (今天 − 该天数)」的日期子目录。
   * 未设置或 ≤0：不自动清理（与旧行为一致）。
   */
  archiveRetentionDays?: number;
  selfImprovingRoot: string;
  /**
   * 为 true 时，在日终改写/删除会话 jsonl 之前，将会话目录下全部 jsonl
   * 复制到状态目录 `pre-refine-snapshots/<日期>/...`，并在 `rotation-state` 中记录路径。
   */
  preRefineSessionSnapshot?: boolean;
  internalScheduler?: InternalSchedulerConfig;
  contextFlush?: {
    enabled?: boolean;
    singleThresholdPercent?: number;
    preemptMarginPercent?: number;
    pollIntervalMs?: number;
    minFlushIntervalMs?: number;
    contextWindowTokens?: number;
    query?: string;
  };
  scheduler: {
    cron: string;
    thresholds: number[];
  };
  injection: {
    format: "toon" | "json";
    fallback: "json";
    singleInjectorRequired: boolean;
    topK: number;
    maxChars: number;
  };
  lancedb: {
    dbPath: string;
    tableName: string;
    embeddingDimensions: number;
  };
  rotation: {
    mode: "rewrite" | "strict";
    allowPermanentDelete: boolean;
    allowBootstrapDelete: boolean;
    /**
     * 跨日 rewrite 时，将保留的新一天内容并入 sessionsRoot 下最新创建的会话文件。
     * 适用于“旧会话已治理/轮转后，新一天继续写入最新会话”的连续性诉求。
     */
    mergeRetainedIntoLatestSession?: boolean;
  };
  governance: {
    hotDays: number;
    warmDays: number;
    retireDays: number;
    excludeAgentOnlyDayFromAging: boolean;
  };
}

export interface RefinedMemory {
  id: string;
  type: string;
  summary: string;
  importance: number;
  date: string;
  sourceKind: string;
  sourceSessionIds: string[];
  tags: string[];
  agentId: string;
  createdAt: string;
  sessionIds: string[];
  agentOnlyDay: boolean;
}
