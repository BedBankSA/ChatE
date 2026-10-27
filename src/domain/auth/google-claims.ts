export type GooglePayload = {
  aud?: string;
  iss?: string;
  exp?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
};

export function assertGoogleClaims(
  payload: GooglePayload | null | undefined,
  expectedAudience: string,
  nowSec: number,
  expectedNonce: string,
): { sub: string; email: string; name: string } {
  if (!payload) throw new Error("GOOGLE_INVALID");
  if (payload.aud !== expectedAudience) throw new Error("GOOGLE_AUDIENCE");
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error("GOOGLE_ISSUER");
  }
  if (!payload.exp || payload.exp <= nowSec) throw new Error("GOOGLE_EXPIRED");
  if (!payload.sub) throw new Error("GOOGLE_SUB");
  if (payload.email_verified !== true || !payload.email) throw new Error("GOOGLE_EMAIL");
  if (!payload.nonce || payload.nonce !== expectedNonce) throw new Error("GOOGLE_NONCE");
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : "",
  };
}

export function profileFromVerifiedClaims(
  claims: { sub: string; email: string; name: string },
  clientBody: { name?: string; email?: string },
): { googleSub: string; email: string; name: string } {
  void clientBody;
  return { googleSub: claims.sub, email: claims.email, name: claims.name };
}
