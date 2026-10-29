const SENSITIVE_KEY = /authorization|api[_-]?key|secret|token|password|otp|code|cookie|prompt|question|content|file|phone|email|conversation/i;

// Free-form strings are not keyed, so a short error or provider message can
// still carry a credential. Scrub the well-known shapes before logging them.
const SECRET_VALUE = /\b(?:sk-ant|sk-or)-[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g;

function scrubString(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    const safe = scrubString(value);
    if (safe.length > 180) return `[text:${safe.length}]`;
    return safe;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return output;
  }
  return "[unsupported]";
}

export function writeLog(event: string, fields: Record<string, unknown>): string {
  const line = JSON.stringify({ event, ...((redact(fields) as Record<string, unknown>) ?? {}) });
  process.stderr.write(`${line}\n`);
  return line;
}
