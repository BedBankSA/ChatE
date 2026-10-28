import { Buffer } from "node:buffer";
import { AppError } from "@/domain/errors";

/**
 * SMS adapter for the OTP flow.
 *
 * Configuration resolves from server-only environment variables and fails
 * closed: a missing, insecure or production-forbidden value throws the same 503
 * OTP_FAIL_CLOSED before a code can be hashed or sent. Every provider outcome
 * (non-2xx, JSON-level failure, timeout, network error, redirect) is the same
 * opaque 502 OTP_PROVIDER: the gateway response body, its request id and the
 * OTP code are never copied into an error, a log line or a response.
 *
 * Wire formats differ per gateway, so each provider converts the Saudi E.164
 * input ("+9665XXXXXXXX", validated before any network call) into the form the
 * carrier expects; the route always hands over the normalized E.164 value.
 */

/** One carrier gateway call must never pin an OTP request forever. */
export const SMS_TIMEOUT_MS = 10_000;

export type SmsSendInput = { to: string; code: string };

export interface SmsSender {
  readonly name: "4jawaly" | "taqnyat" | "unifonic" | "generic" | "mock";
  send(input: SmsSendInput): Promise<void>;
}

/** Options accepted by every concrete provider; tests inject a fake fetch. */
export type SmsProviderOptions = {
  /** Injected in tests only; production resolves the global fetch at construction. */
  fetchImpl?: typeof fetch;
  /** Per-request deadline in milliseconds; defaults to SMS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Environment used for the endpoint policy; defaults to NODE_ENV. */
  nodeEnv?: string;
  /** Approved message template (SMS_OTP_TEXT) containing the {code} placeholder. */
  otpText?: string;
};

export type FourJawalyOptions = SmsProviderOptions & {
  apiKey: string;
  apiSecret: string;
  sender: string;
  endpoint?: string;
};

export type TaqnyatOptions = SmsProviderOptions & {
  apiKey: string;
  sender: string;
  endpoint?: string;
};

export type UnifonicOptions = SmsProviderOptions & {
  apiKey: string;
  sender: string;
  endpoint?: string;
};

export type GenericHttpOptions = SmsProviderOptions & {
  endpoint?: string;
  /** Full Authorization header value; absent means the gateway needs none. */
  authorization?: string;
};

/** Arabic default; SMS_OTP_TEXT can replace it as long as {code} survives. */
const DEFAULT_OTP_TEXT = "رمز التحقق في ChatE: {code}. لا تشاركه مع أحد.";

const FOURJAWALY_ENDPOINT = "https://api-sms.4jawaly.com/api/v1/account/area/sms/send";
const TAQNYAT_ENDPOINT = "https://api.taqnyat.sa/v1/messages";
const UNIFONIC_ENDPOINT = "https://el.cloud.unifonic.com/rest/SMS/messages";

const SAUDI_E164_PATTERN = /^\+9665[0-9]{8}$/;
const OTP_CODE_PATTERN = /^[0-9]{6}$/;
/** Hard cap on a gateway body; a hostile or broken gateway cannot stream forever. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Configuration problems fail closed (503) so a broken deployment sends nothing. */
function smsConfigError(): AppError {
  return new AppError("مزود الرسائل غير مهيأ", "OTP_FAIL_CLOSED", 503);
}

/** One opaque provider failure (502) for every gateway outcome. */
function smsProviderError(): AppError {
  return new AppError("تعذر إرسال رمز التحقق", "OTP_PROVIDER", 502);
}

function resolveNodeEnv(explicit?: string): string {
  const value = explicit ?? process.env.NODE_ENV;
  const resolved = value?.trim();
  // Fail closed: an unset or blank NODE_ENV must never be read as development,
  // because that would enable the dev mock provider and the loopback plain-http
  // endpoint exception outside production. Only an explicit non-production value
  // opens those paths.
  return resolved ? resolved : "production";
}

function resolveTimeoutMs(raw?: number): number {
  const timeoutMs = raw ?? SMS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw smsConfigError();
  return timeoutMs;
}

function resolveOtpTemplate(raw?: string): string | undefined {
  const template = raw?.trim();
  if (!template) return undefined;
  // A template without {code} would deliver a useless SMS, so it is a
  // configuration error instead of a silent empty message.
  if (!template.includes("{code}")) throw smsConfigError();
  return template;
}

function requireCredential(raw: string | undefined): string {
  const credential = raw?.trim();
  if (!credential) throw smsConfigError();
  return credential;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/**
 * Validates a gateway endpoint before any code can leave the process. The
 * code-bearing request must travel over TLS in every real deployment; plain
 * http is accepted only for a loopback host outside production, which keeps the
 * local dev stub usable without weakening production. Credential-bearing URLs
 * fail closed because a URL can be printed by a proxy or an error page.
 */
function validateSmsEndpoint(raw: string | undefined, nodeEnv: string): string {
  const candidate = raw?.trim() ?? "";
  if (!candidate) throw smsConfigError();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw smsConfigError();
  }
  if (url.username || url.password) throw smsConfigError();
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && nodeEnv !== "production" && isLoopbackHost(url.hostname)) return url.href;
  throw smsConfigError();
}

/** A blank override means "use the documented default endpoint", not a broken URL. */
function resolveEndpoint(override: string | undefined, fallback: string, nodeEnv: string): string {
  return validateSmsEndpoint(override?.trim() || fallback, nodeEnv);
}

/** Every provider refuses a payload outside the route contract before the wire. */
function requireSmsInput(input: SmsSendInput): void {
  if (!input || typeof input.to !== "string" || !SAUDI_E164_PATTERN.test(input.to)) throw smsProviderError();
  if (typeof input.code !== "string" || !OTP_CODE_PATTERN.test(input.code)) throw smsProviderError();
}

function internationalDigits(to: string): string {
  return to.slice(1);
}

function renderOtpText(code: string, template: string | undefined): string {
  return buildOtpText(code, template === undefined ? {} : { SMS_OTP_TEXT: template });
}

/**
 * Builds the SMS body from the default Arabic text or the SMS_OTP_TEXT template.
 * The template is optional; every occurrence of {code} is replaced.
 */
export function buildOtpText(code: string, env: Record<string, string | undefined> = {}): string {
  const template = env.SMS_OTP_TEXT?.trim() || DEFAULT_OTP_TEXT;
  return template.replaceAll("{code}", code);
}

/**
 * Reads at most MAX_RESPONSE_BYTES of a gateway body and always releases the
 * stream. Returns null when the body is larger than the cap or cannot be read;
 * the caller treats that as a provider failure because success cannot be proven.
 */
async function readCappedText(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored/closed; the HTTP outcome still decides.
    }
  }
}

/** Drops a body we never need; a large or streaming body cannot pin the socket. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that already errored needs no cleanup; the status still decides.
  }
}

async function readJsonStrict(response: Response): Promise<unknown> {
  const text = await readCappedText(response);
  if (text === null) throw smsProviderError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw smsProviderError();
  }
}

async function readJsonOptional(response: Response): Promise<unknown> {
  const text = await readCappedText(response);
  // Oversized bodies are rejected: a JSON-level failure flag could be hiding
  // beyond the cap, so success cannot be proven.
  if (text === null) throw smsProviderError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Shared wire hardening for every HTTP gateway: POST JSON, never follow a
 * redirect, never cache, always use the deadline, and map every transport
 * exception to the same opaque error.
 */
abstract class HttpSmsProvider {
  abstract readonly name: SmsSender["name"];
  protected readonly nodeEnv: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly otpTemplate: string | undefined;

  constructor(options: SmsProviderOptions) {
    const fetchImpl = options.fetchImpl ?? fetch;
    if (typeof fetchImpl !== "function") throw smsConfigError();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = resolveTimeoutMs(options.timeoutMs);
    this.otpTemplate = resolveOtpTemplate(options.otpText);
    this.nodeEnv = resolveNodeEnv(options.nodeEnv);
  }

  protected textFor(code: string): string {
    return renderOtpText(code, this.otpTemplate);
  }

  protected async post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        // Never follow a redirect: an OTP code must not be replayed to a
        // Location chosen by a misconfigured or compromised gateway.
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // DNS/connect failure, deadline or a refused redirect. The original error
      // is dropped so no provider or network detail can reach the caller.
      throw smsProviderError();
    }
  }
}

/**
 * LIVE provider (4jawaly). Success is stricter than HTTP 2xx: the account API
 * acknowledges acceptance inside the JSON envelope, so a 200 with code != 200 or
 * a per-message error is still a failed delivery.
 */
export class FourJawalyProvider extends HttpSmsProvider {
  readonly name = "4jawaly" as const;
  private readonly endpoint: string;
  private readonly authorization: string;
  private readonly sender: string;

  constructor(options: FourJawalyOptions) {
    super(options);
    const apiKey = requireCredential(options.apiKey);
    const apiSecret = requireCredential(options.apiSecret);
    this.sender = requireCredential(options.sender);
    this.endpoint = resolveEndpoint(options.endpoint, FOURJAWALY_ENDPOINT, this.nodeEnv);
    this.authorization = "Basic " + Buffer.from(apiKey + ":" + apiSecret, "utf8").toString("base64");
  }

  async send(input: SmsSendInput): Promise<void> {
    requireSmsInput(input);
    const response = await this.post(
      this.endpoint,
      {
        Accept: "application/json",
        "Accept-Language": "ar",
        Authorization: this.authorization,
      },
      {
        messages: [
          {
            text: this.textFor(input.code),
            numbers: [internationalDigits(input.to)],
            number_iso: "SA",
            sender: this.sender,
          },
        ],
      },
    );
    if (!response.ok) {
      await discardBody(response);
      throw smsProviderError();
    }
    const payload = await readJsonStrict(response);
    if (!isFourJawalySuccess(payload)) throw smsProviderError();
  }
}

/**
 * Observed 4jawaly success envelope. Every message entry must prove one accepted
 * SMS with no error; unknown shapes are treated as failures.
 */
function isFourJawalySuccess(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.code !== 200) return false;
  if (!Array.isArray(record.messages) || record.messages.length === 0) return false;
  return record.messages.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const message = entry as Record<string, unknown>;
    return (
      message.error_count === 0 && typeof message.success_count === "number" && message.success_count >= 1
    );
  });
}

/** Taqnyat: Bearer token, recipients in international digits, optional statusCode. */
export class TaqnyatProvider extends HttpSmsProvider {
  readonly name = "taqnyat" as const;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly sender: string;

  constructor(options: TaqnyatOptions) {
    super(options);
    this.apiKey = requireCredential(options.apiKey);
    this.sender = requireCredential(options.sender);
    this.endpoint = resolveEndpoint(options.endpoint, TAQNYAT_ENDPOINT, this.nodeEnv);
  }

  async send(input: SmsSendInput): Promise<void> {
    requireSmsInput(input);
    const response = await this.post(
      this.endpoint,
      { Authorization: "Bearer " + this.apiKey },
      {
        recipients: [internationalDigits(input.to)],
        body: this.textFor(input.code),
        sender: this.sender,
      },
    );
    if (!response.ok) {
      await discardBody(response);
      throw smsProviderError();
    }
    const payload = await readJsonOptional(response);
    if (hasTaqnyatStatusCode(payload) && !isSuccessStatusCode(payload)) throw smsProviderError();
  }
}

/**
 * Taqnyat reports a JSON statusCode on some plans; when it is present it must
 * agree with the HTTP 2xx already observed. A non-JSON 2xx body stays a success
 * per the documented contract.
 */
function hasTaqnyatStatusCode(payload: unknown): payload is { statusCode: unknown } {
  return typeof payload === "object" && payload !== null && "statusCode" in payload;
}

function isSuccessStatusCode(payload: { statusCode: unknown }): boolean {
  const statusCode = Number(payload.statusCode);
  return Number.isFinite(statusCode) && statusCode >= 200 && statusCode <= 299;
}

/** Unifonic: AppSid in the JSON body, no Authorization header. */
export class UnifonicProvider extends HttpSmsProvider {
  readonly name = "unifonic" as const;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly sender: string;

  constructor(options: UnifonicOptions) {
    super(options);
    this.apiKey = requireCredential(options.apiKey);
    this.sender = requireCredential(options.sender);
    this.endpoint = resolveEndpoint(options.endpoint, UNIFONIC_ENDPOINT, this.nodeEnv);
  }

  async send(input: SmsSendInput): Promise<void> {
    requireSmsInput(input);
    const response = await this.post(this.endpoint, {}, {
      AppSid: this.apiKey,
      SenderID: this.sender,
      Recipient: internationalDigits(input.to),
      Body: this.textFor(input.code),
    });
    if (!response.ok) {
      await discardBody(response);
      throw smsProviderError();
    }
    const payload = await readJsonOptional(response);
    if (typeof payload === "object" && payload !== null && (payload as Record<string, unknown>).success === false) {
      throw smsProviderError();
    }
  }
}

/**
 * Generic/legacy HTTP gateway: the historical wire shape is {"to","code"} with
 * an optional Authorization header. This is the bridge for OTP_PROVIDER=http so
 * existing QA scripts keep working unchanged.
 */
export class GenericHttpProvider extends HttpSmsProvider {
  readonly name = "generic" as const;
  private readonly endpoint: string;
  private readonly authorization: string | undefined;

  constructor(options: GenericHttpOptions) {
    super(options);
    this.endpoint = validateSmsEndpoint(options.endpoint, this.nodeEnv);
    this.authorization = options.authorization?.trim() || undefined;
  }

  async send(input: SmsSendInput): Promise<void> {
    requireSmsInput(input);
    const headers: Record<string, string> = this.authorization ? { Authorization: this.authorization } : {};
    const response = await this.post(this.endpoint, headers, { to: input.to, code: input.code });
    await discardBody(response);
    if (!response.ok) throw smsProviderError();
  }
}

/**
 * Development/test stub. It never calls the network and exists only so a local
 * flow can be completed without a paid gateway; production construction throws
 * the same 503 configuration error as any other forbidden provider.
 */
export class MockDevProvider implements SmsSender {
  readonly name = "mock" as const;

  constructor(options: SmsProviderOptions = {}) {
    if (resolveNodeEnv(options.nodeEnv) === "production") throw smsConfigError();
  }

  async send(input: SmsSendInput): Promise<void> {
    requireSmsInput(input);
    // Local convenience only: the constructor above already refuses production,
    // so the code never reaches a production log line.
    console.log("[sms-mock] OTP generated for " + input.to + " (code " + input.code + ", dev/test only)");
  }
}

/**
 * Resolves the one sender for this process. Legacy OTP_PROVIDER keeps precedence
 * when non-empty (QA scripts and existing deployments depend on it); otherwise
 * SMS_PROVIDER selects the new gateway. Anything unconfigured or unknown fails
 * closed with 503 instead of silently dropping the OTP.
 */
export function createSmsSender(env: Record<string, string | undefined>): SmsSender {
  const nodeEnv = resolveNodeEnv(env.NODE_ENV);
  const legacyProvider = env.OTP_PROVIDER?.trim().toLowerCase();
  if (legacyProvider) {
    if (legacyProvider === "http") {
      // Legacy bridge: OTP_HTTP_URL + OTP_HTTP_AUTHORIZATION verbatim.
      return new GenericHttpProvider({
        endpoint: env.OTP_HTTP_URL,
        authorization: env.OTP_HTTP_AUTHORIZATION,
        nodeEnv,
      });
    }
    if (legacyProvider === "fake") return new MockDevProvider({ nodeEnv });
    throw smsConfigError();
  }
  const provider = env.SMS_PROVIDER?.trim().toLowerCase();
  switch (provider) {
    case "4jawaly":
      return new FourJawalyProvider({
        apiKey: env.SMS_API_KEY ?? "",
        apiSecret: env.SMS_API_SECRET ?? "",
        sender: env.SMS_SENDER_ID ?? "",
        endpoint: env.SMS_ENDPOINT,
        otpText: env.SMS_OTP_TEXT,
        nodeEnv,
      });
    case "taqnyat":
      return new TaqnyatProvider({
        apiKey: env.SMS_API_KEY ?? "",
        sender: env.SMS_SENDER_ID ?? "",
        endpoint: env.SMS_ENDPOINT,
        otpText: env.SMS_OTP_TEXT,
        nodeEnv,
      });
    case "unifonic":
      return new UnifonicProvider({
        apiKey: env.SMS_API_KEY ?? "",
        sender: env.SMS_SENDER_ID ?? "",
        endpoint: env.SMS_ENDPOINT,
        otpText: env.SMS_OTP_TEXT,
        nodeEnv,
      });
    case "generic": {
      const apiKey = env.SMS_API_KEY?.trim();
      return new GenericHttpProvider({
        // New deployments set SMS_ENDPOINT; the legacy OTP_HTTP_URL is the
        // documented fallback so the admin gate and the route agree.
        endpoint: env.SMS_ENDPOINT?.trim() || env.OTP_HTTP_URL,
        // New-style generic auth is opt-in: Bearer <SMS_API_KEY>.
        authorization: apiKey ? "Bearer " + apiKey : undefined,
        nodeEnv,
      });
    }
    case "mock":
      return new MockDevProvider({ nodeEnv });
    default:
      throw smsConfigError();
  }
}
