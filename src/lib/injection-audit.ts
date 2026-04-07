/**
 * Guardrails: prompt injections must come from approved sources (LanceDB, in-memory hooks),
 * not ad-hoc reads of governor context-pack or audit markdown on disk.
 */

const DENIED_PATH_SUBSTRINGS = [
  "context-pack.md",
  "context-pack.meta.json",
  "/.learnings/",
  "\\.learnings\\",
  "audit-rollback",
];

export function isDeniedInjectionDiskPath(filePath: string): boolean {
  const p = filePath.toLowerCase();
  return DENIED_PATH_SUBSTRINGS.some((s) => p.includes(s.toLowerCase()));
}

export function warnDeniedInjectionRead(
  logWarn: (msg: string) => void,
  filePath: string,
  reason: string,
): boolean {
  if (!isDeniedInjectionDiskPath(filePath)) return false;
  logWarn(
    `memory-lancedb-pro: injection-audit: rejected disk path for prompt injection path=${filePath} reason=${reason}`,
  );
  return true;
}
