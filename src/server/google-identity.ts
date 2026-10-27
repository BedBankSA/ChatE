import { OAuth2Client } from "google-auth-library";
import { assertGoogleClaims, type GoogleClaims } from "@/domain/auth/google";

export async function verifyGoogleIdToken(idToken: string, audience: string): Promise<GoogleClaims | null> {
  const client = new OAuth2Client(audience);
  const ticket = await client.verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  if (!payload) return null;
  const tokenAudience = Array.isArray(payload.aud) ? payload.aud[0] ?? "" : String(payload.aud ?? "");
  return {
    sub: payload.sub ?? "",
    email: payload.email ?? "",
    name: payload.name ?? "",
    aud: tokenAudience,
    iss: payload.iss ?? "",
    exp: payload.exp ?? 0,
    email_verified: payload.email_verified,
    nonce: payload.nonce,
  };
}

export function acceptGoogleIdentity(
  claims: GoogleClaims | null,
  audience: string,
  nonce: string,
  nowSec: number,
): { sub: string; email: string; name: string } {
  return assertGoogleClaims(claims, audience, nonce, nowSec);
}
