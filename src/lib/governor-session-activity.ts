/**
 * 网关心跳内追踪「会话是否可能在写入 jsonl」，供日终 rotate 前安全门使用。
 * 与 agent 工具并发无关时仅靠 mtime；此处覆盖用户消息开始、整轮结束后的异步落盘窗口。
 */

type SessionBusyState = {
  /** 已收到用户消息、尚未完成本轮 agent_end 计数的区间 */
  refCount: number;
  /** agent_end 后仍视为危险的时间戳（含 auto-capture 等异步 append） */
  activeUntil: number;
};

const sessions = new Map<string, /** SessionBusyState */ SessionBusyState>();

function key(sessionId: string): string {
  const k = sessionId.trim();
  return k.length > 0 ? k : "default";
}

export function governorMarkSessionUserTurnStart(sessionId: string): void {
  const id = key(sessionId);
  const s = sessions.get(id) ?? { refCount: 0, activeUntil: 0 };
  s.refCount += 1;
  sessions.set(id, s);
}

/**
 * 在 agent_end 被调用时：结束本轮同步计数，并把静默期延长到 now + postTurnQuietMs。
 */
export function governorMarkSessionAgentTurnEnded(
  sessionId: string,
  postTurnQuietMs: number,
): void {
  const id = key(sessionId);
  const s = sessions.get(id) ?? { refCount: 0, activeUntil: 0 };
  if (s.refCount > 0) s.refCount -= 1;
  const until = Date.now() + Math.max(0, postTurnQuietMs);
  s.activeUntil = Math.max(s.activeUntil, until);
  sessions.set(id, s);

  // 定期瘦身：无引用且已过静默很久的条目删除
  if (s.refCount === 0 && s.activeUntil < Date.now() - 3_600_000) {
    sessions.delete(id);
  }
}

/** 会话 jsonl 文件名（不含扩展名）是否在「可能正在写入」窗口内 */
export function governorIsSessionStemBusy(stem: string): boolean {
  return governorIsSessionIdBusy(stem);
}

export function governorIsSessionIdBusy(sessionId: string): boolean {
  const s = sessions.get(key(sessionId));
  if (!s) return false;
  const now = Date.now();
  return s.refCount > 0 || now < s.activeUntil;
}

export function governorPruneStaleActivity(now = Date.now()): void {
  for (const [id, s] of sessions.entries()) {
    if (s.refCount === 0 && s.activeUntil < now - 3_600_000) {
      sessions.delete(id);
    }
  }
}

/** session_end：视为本轮已结束，清零引用并延长静默（防末尾异步仍写 jsonl） */
export function governorMarkSessionClosed(sessionId: string, postTurnQuietMs: number): void {
  const id = key(sessionId);
  const s = sessions.get(id) ?? { refCount: 0, activeUntil: 0 };
  s.refCount = 0;
  const until = Date.now() + Math.max(0, postTurnQuietMs);
  s.activeUntil = Math.max(s.activeUntil, until);
  sessions.set(id, s);
}
