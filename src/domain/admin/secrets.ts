import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_SERVICES = [
  "openrouter_inference",
  "openrouter_management",
  "turnstile",
  "google",
  "otp",
  "storage",
] as const;

export type SecretService = (typeof SECRET_SERVICES)[number];

export const PINNED_TURNSTILE_SITE_KEY = "0x4AAAAAAFoJLWRjfC1ZYlwB";
export const FIXED_ENDPOINTS: Partial<Record<SecretService, string>> = {
  openrouter_inference: "https://openrouter.ai",
  openrouter_management: "https://openrouter.ai",
  turnstile: "https://challenges.cloudflare.com",
  google: "https://oauth2.googleapis.com",
};

export function isSecretService(value: string): value is SecretService {
  return SECRET_SERVICES.includes(value as SecretService);
}

export function parseEncryptionKey(value: string | undefined): Buffer | null {
  if (!value?.trim()) return null;
  try {
    const key = Buffer.from(value.trim(), "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function encryptSecret(plain: string, key: Buffer): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([encrypted, tag]).toString("base64"), nonce: nonce.toString("base64") };
}

export function decryptSecret(ciphertext: string, nonce: string, key: Buffer): string {
  const packed = Buffer.from(ciphertext, "base64");
  if (packed.length < 17) throw new Error("SECRET_BOX");
  const tag = packed.subarray(packed.length - 16);
  const body = packed.subarray(0, packed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function lastFour(secret: string): string | null {
  if (secret.length < 8) return null;
  return secret.slice(-4);
}

export function rejectForeignEndpoint(body: Record<string, unknown>, service: SecretService): string | null {
  for (const key of ["baseUrl", "base_url", "url", "endpoint", "host"]) {
    if (key in body) return "لا يُقبل عنوان قاعدة خارجي من لوحة الإدارة";
  }
  const fixed = FIXED_ENDPOINTS[service];
  if (fixed && typeof body.endpoint === "string" && body.endpoint !== fixed) return "عنوان الخدمة ثابت";
  return null;
}

export function activationAllowed(service: SecretService, testPassed: boolean): { ok: true } | { ok: false; reason: string } {
  if (!testPassed) return { ok: false, reason: "الاختبار لم ينجح، والمفتاح العامل يبقى مكانه" };
  if (service === "google") return { ok: false, reason: "لا يُفعَّل معرف Google قبل اختبار دخول ناجح حتى لا يُقفل المالك" };
  if (service === "otp") return { ok: false, reason: "لم تُرسل رسالة اختبار، لذلك لا يُستبدل مفتاح الرسائل" };
  if (service === "storage") return { ok: false, reason: "مسار التخزين لا يُستبدل من اللوحة" };
  return { ok: true };
}

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function runtimeEnvironment(nodeEnv: string | undefined): "dev" | "prod" {
  return nodeEnv === "production" ? "prod" : "dev";
}
