import path from "node:path";
import { appendJsonl, ensureDir } from "./fsx";

export function createLogger(stateDir: string, jobId: string) {
  ensureDir(stateDir);
  const auditPath = path.join(stateDir, "audit.jsonl");
  const log = (level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) => {
    appendJsonl(auditPath, { ts: new Date().toISOString(), level, event, jobId, ...data });
  };
  return {
    info: (event: string, data?: Record<string, unknown>) => log("info", event, data),
    warn: (event: string, data?: Record<string, unknown>) => log("warn", event, data),
    error: (event: string, data?: Record<string, unknown>) => log("error", event, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;

