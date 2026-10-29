import { AppError } from "@/domain/errors";

export type GoogleClaims = {
  sub: string;
  email: string;
  name: string;
  aud: string;
  iss: string;
  exp: number;
  email_verified?: boolean;
  nonce?: string;
};

export function assertGoogleClaims(
  payload: GoogleClaims | null,
  expectedAudience: string,
  expectedNonce: string,
  nowSec: number,
): { sub: string; email: string; name: string } {
  if (!payload) throw new AppError("رمز Google غير صالح", "GOOGLE_TOKEN", 401);
  if (payload.aud !== expectedAudience) throw new AppError("جمهور الرمز غير مطابق", "GOOGLE_AUD", 401);
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new AppError("مُصدر الرمز غير مطابق", "GOOGLE_ISS", 401);
  }
  if (!payload.exp || payload.exp <= nowSec) throw new AppError("انتهت صلاحية الرمز", "GOOGLE_EXP", 401);
  if (!payload.sub) throw new AppError("معرف الحساب غائب", "GOOGLE_SUB", 401);
  if (payload.email_verified !== true || !payload.email) {
    throw new AppError("البريد غير متحقق من Google", "GOOGLE_EMAIL", 401);
  }
  if (!payload.nonce || payload.nonce !== expectedNonce) {
    throw new AppError("رمز nonce غير مطابق", "GOOGLE_NONCE", 401);
  }
  return { sub: payload.sub, email: payload.email, name: payload.name ?? "" };
}

export function profileFromVerifiedClaims(
  claims: { sub: string; email: string; name: string },
  clientBody: { name?: string; email?: string },
): { googleSub: string; email: string; name: string } {
  void clientBody;
  return { googleSub: claims.sub, email: claims.email, name: claims.name };
}
