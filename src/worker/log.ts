type Level = "info" | "warn" | "error";

/** Structured log line for Workers Logs. Never pass tokens, secrets or interview content. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
