export function redactErrorCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  if (upper.includes("SK-") || upper.includes("BEARER")) return "REDACTED";
  const token = upper.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!token) return "PROVIDER";
  return token.slice(0, 64);
}
