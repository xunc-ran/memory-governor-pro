const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-(?:proj-)?[a-zA-Z0-9]{24,}/g, "[REDACTED:OPENAI]"],
  [/sk-ant-[a-zA-Z0-9\-_]{24,}/g, "[REDACTED:ANTHROPIC]"],
  [/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED:GITHUB]"],
  [/AKIA[A-Z0-9]{16}/g, "[REDACTED:AWS]"],
  [/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, "[REDACTED:TOKEN]"],
];

export function sanitize(text: string): string {
  let out = text || "";
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

