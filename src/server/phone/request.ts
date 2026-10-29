/**
 * Client attribution for the permanent phone audit trail. Proxy headers are
 * advisory (a client can forge them when no trusted proxy rewrites them), so the
 * admin UI labels this column as network metadata, never as proof of identity.
 */
export type ClientMeta = {
  ip: string | null;
  userAgent: string | null;
};

export function readClientMeta(request: Request): ClientMeta {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = cloudflare || forwarded || null;
  const userAgent = request.headers.get("user-agent");
  return {
    ip: ip ? ip.slice(0, 64) : null,
    userAgent: userAgent ? userAgent.slice(0, 400) : null,
  };
}
