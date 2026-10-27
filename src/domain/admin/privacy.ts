const FORBIDDEN_KEY = /^(question|output_text|outputtext|input_label|inputlabel|prompt|completion|original_name|originalname|storage_key|storagekey|snippet|summary|conversation|messages|message|filename|file_name|ciphertext|nonce|secret|api_key|apikey|authorization|password|code_hash|requested_settings|requestedsettings|evidence|payload|transcript|answer|output|content|title|text|body)$/i;

export function stripPrivateKeys(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => stripPrivateKeys(item, depth + 1));
  if (typeof value !== "object") return null;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    output[key] = stripPrivateKeys(item, depth + 1);
  }
  return output;
}

export function removeSecretValues(json: string, secrets: string[]): string {
  let text = json;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    text = text.split(secret).join("[redacted]");
  }
  return text;
}

export function containsCanary(json: string, canaries: string[]): string | null {
  for (const canary of canaries) {
    if (canary && json.includes(canary)) return canary;
  }
  return null;
}
