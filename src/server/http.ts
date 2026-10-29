export function jsonOk(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data, error: null }, { status });
}

export function jsonError(message: string, code: string, status: number): Response {
  return Response.json({ ok: false, data: null, error: { message, code } }, { status });
}
