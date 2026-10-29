import { readTurnstileToken } from "@/domain/auth/turnstile";
import { publicError } from "@/domain/errors";
import { getDatabase } from "@/server/db/runtime";
import { jsonError } from "@/server/http";
import { requireTurnstile } from "@/server/turnstile";

/**
 * Upper bound for any JSON request body this app parses. Route handlers run on
 * a Node server with no framework body limit here, so without a cap a single
 * request could force a multi-megabyte allocation. Oversized bodies are treated
 * exactly like malformed JSON ({}), so every existing validation path answers
 * with its normal 4xx instead of a 500.
 */
export const MAX_JSON_BYTES = 1024 * 1024;

export async function readJson(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  const declared = declaredLength(request);
  if (declared != null && declared > maxBytes) return {};
  let text: string | null;
  try {
    text = await readBodyText(request, maxBytes);
  } catch {
    // A truncated or aborted body is treated like an empty JSON object so the
    // route can answer with a validation error instead of a 500.
    return {};
  }
  if (text === null) return {};
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads at most maxBytes; returns null as soon as the stream exceeds the cap. */
async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Defense-in-depth CSRF check for browser requests. SameSite=Lax on the session
 * cookie is the primary control; this adds an Origin/Referer host check so a
 * future cookie-policy change or a same-site sibling origin cannot silently
 * turn state-changing JSON routes into CSRF targets.
 *
 * Non-browser clients send no Origin/Referer and are allowed (the alternative
 * would break curl/server-to-server use with no CSRF benefit). A malformed or
 * opaque ("null") origin fails closed.
 */
export function sameOriginRequest(request: Request): boolean {
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return true;
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host.toLowerCase();
  } catch {
    return false;
  }
  if (!sourceHost) return false;
  const candidates = [
    request.headers.get("host"),
    firstForwardedHost(request.headers.get("x-forwarded-host")),
  ];
  try {
    candidates.push(new URL(request.url).host.toLowerCase());
  } catch {
    // A URL that cannot be parsed adds no candidate.
  }
  return candidates.some(
    (candidate) => typeof candidate === "string" && candidate.trim().toLowerCase() === sourceHost,
  );
}

function firstForwardedHost(value: string | null): string | null {
  const first = (value ?? "").split(",")[0]?.trim().toLowerCase();
  return first || null;
}

export type RateLimitOptions = {
  capacity?: number;
  refillPerMinute?: number;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
};

type Bucket = { tokens: number; updatedAt: number };

const DEFAULT_CAPACITY = 20;
const DEFAULT_REFILL_PER_MINUTE = 20;
// Non-proxied local requests cannot be attributed to a single client, so the
// shared fallback bucket is more generous to avoid throttling the whole dev box.
const LOCAL_FALLBACK_CAPACITY = 60;
const MAX_BUCKETS = 4096;
const buckets = new Map<string, Bucket>();

/** Test helper only; production buckets expire on their own. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Client address for rate limiting; proxy headers first, then a shared local key. */
export function clientAddress(request: Request): string {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "local";
}

/**
 * In-memory token bucket. This is a best-effort abuse brake for a single
 * server process: with several processes each keeps its own buckets, and a
 * restart clears them. It complements (never replaces) Turnstile, quota, and
 * the SQLite-backed OTP resend counter.
 */
export function consumeRateLimit(
  key: string,
  options: RateLimitOptions = {},
): { allowed: boolean; retryAfterSeconds: number } {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const refillPerMinute = options.refillPerMinute ?? DEFAULT_REFILL_PER_MINUTE;
  const now = options.now ?? Date.now();
  if (buckets.size >= MAX_BUCKETS) pruneBuckets(now);
  let bucket = buckets.get(key);
  if (!bucket) bucket = { tokens: capacity, updatedAt: now };
  const elapsedMs = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs * refillPerMinute) / 60_000);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  buckets.set(key, bucket);
  const retryAfterSeconds = Math.max(1, Math.ceil(((1 - bucket.tokens) / refillPerMinute) * 60));
  return { allowed: false, retryAfterSeconds };
}

/** Returns a 429 response when the caller is over its bucket, otherwise null. */
export function rateLimitResponse(
  request: Request,
  kind: string,
  options: RateLimitOptions = {},
): Response | null {
  const address = clientAddress(request);
  const capacity =
    options.capacity ?? (address === "local" ? LOCAL_FALLBACK_CAPACITY : DEFAULT_CAPACITY);
  const verdict = consumeRateLimit(`${kind}:${address}`, { ...options, capacity });
  if (verdict.allowed) return null;
  const response = jsonError("عدد المحاولات كبير. انتظر قليلاً ثم أعد المحاولة.", "rate_limit", 429);
  response.headers.set("retry-after", String(verdict.retryAfterSeconds));
  return response;
}

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 10 * 60_000) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS - 1) {
    const oldest = buckets.keys().next();
    if (oldest.done) return;
    buckets.delete(oldest.value);
  }
}

// Login and OTP send are the two unauthenticated-ish entry points that cost an
// external verification (Cloudflare / SMS). Comparison and upload already sit
// behind a session, quota, and Turnstile, so they are not throttled here.
const RATE_LIMITED_ACTIONS = new Set(["login", "otp"]);

export async function gateTurnstile(
  request: Request,
  body: Record<string, unknown>,
  expectedAction: string,
): Promise<Response | null> {
  if (!sameOriginRequest(request)) {
    return jsonError("الطلب مرفوض.", "origin", 403);
  }
  if (RATE_LIMITED_ACTIONS.has(expectedAction)) {
    const limited = rateLimitResponse(request, `turnstile:${expectedAction}`);
    if (limited) return limited;
  }
  try {
    await requireTurnstile({
      request,
      token: readTurnstileToken(body),
      expectedAction,
      // Resolved lazily: a request without a token never opens the database,
      // and a store failure degrades to the bounded in-process replay guard.
      database: optionalDatabase,
    });
    return null;
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
}

function optionalDatabase() {
  try {
    return getDatabase();
  } catch {
    return undefined;
  }
}
