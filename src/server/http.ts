export function jsonOk(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data, error: null }, { status });
}

/**
 * Every API error keeps the historical { message, code } contract and may add
 * machine-readable details (retryAfterSeconds, remainingAttempts, ...) so the
 * browser can render a real countdown instead of guessing.
 */
export function jsonError(
  message: string,
  code: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    { ok: false, data: null, error: { message, code, ...(details ?? {}) } },
    { status },
  );
}