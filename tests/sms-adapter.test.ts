import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import {
  FourJawalyProvider,
  GenericHttpProvider,
  MockDevProvider,
  SMS_TIMEOUT_MS,
  TaqnyatProvider,
  UnifonicProvider,
  buildOtpText,
  createSmsSender,
  type SmsSender,
} from "@/server/sms/adapter";

const TO = "+966564106506";
const CODE = "123456";
const CONFIG_MESSAGE = "مزود الرسائل غير مهيأ";
const PROVIDER_MESSAGE = "تعذر إرسال رمز التحقق";

/** LIVE success envelope observed 2026-10-28 (values are disposable here). */
const LIVE_SUCCESS = {
  code: 200,
  message: "تم حفظ الرسائل بنجاح",
  messages: [
    { job_id: "job-live-1", success_count: 1, error_count: 0, duplicated_count: 0, total_cost: 1 },
  ],
  job_id: "job-live-1",
  request_id: "request-live-1",
};

type Captured = {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: unknown;
};

type Responder = (captured: Captured) => Response | Promise<Response>;

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Injected fake fetch: no test ever reaches a real network or the global fetch. */
function installFakeFetch(responder: Response | Responder): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input),
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: parseJsonBody(init?.body),
    };
    calls.push(captured);
    return typeof responder === "function" ? responder(captured) : responder;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function fourJawaly(
  fetchImpl: typeof fetch,
  options: { endpoint?: string; otpText?: string; timeoutMs?: number } = {},
): FourJawalyProvider {
  return new FourJawalyProvider({
    apiKey: "test-key",
    apiSecret: "test-secret",
    sender: "BedBank",
    nodeEnv: "test",
    fetchImpl,
    ...options,
  });
}

function taqnyat(
  fetchImpl: typeof fetch,
  options: { endpoint?: string; otpText?: string } = {},
): TaqnyatProvider {
  return new TaqnyatProvider({
    apiKey: "taqnyat-token",
    sender: "BedBank",
    nodeEnv: "test",
    fetchImpl,
    ...options,
  });
}

function unifonic(
  fetchImpl: typeof fetch,
  options: { endpoint?: string; otpText?: string } = {},
): UnifonicProvider {
  return new UnifonicProvider({
    apiKey: "unifonic-app-sid",
    sender: "BedBank",
    nodeEnv: "test",
    fetchImpl,
    ...options,
  });
}

function generic(
  fetchImpl: typeof fetch,
  options: { endpoint?: string; authorization?: string } = {},
): GenericHttpProvider {
  return new GenericHttpProvider({
    endpoint: "https://sms.example/send",
    nodeEnv: "test",
    fetchImpl,
    ...options,
  });
}

function allProviders(fetchImpl: typeof fetch): SmsSender[] {
  return [
    fourJawaly(fetchImpl),
    taqnyat(fetchImpl),
    unifonic(fetchImpl),
    generic(fetchImpl),
    new MockDevProvider({ nodeEnv: "test" }),
  ];
}

function expectConfigError(action: () => unknown, label?: string): AppError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught, label).toBeInstanceOf(AppError);
  expect(caught, label).toMatchObject({ code: "OTP_FAIL_CLOSED", statusCode: 503, message: CONFIG_MESSAGE });
  return caught as AppError;
}

async function expectProviderFailure(action: () => unknown): Promise<AppError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code: "OTP_PROVIDER", statusCode: 502, message: PROVIDER_MESSAGE });
  return caught as AppError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildOtpText", () => {
  it("uses a short Arabic default with the code interpolated", () => {
    const text = buildOtpText(CODE);
    expect(text).toContain(CODE);
    expect(text).toContain("ChatE");
    expect(text).not.toContain("{code}");
  });

  it("prefers and trims the SMS_OTP_TEXT template, replacing every occurrence", () => {
    expect(buildOtpText("654321", { SMS_OTP_TEXT: "  رمزك: {code}  " })).toBe("رمزك: 654321");
    expect(buildOtpText("111111", { SMS_OTP_TEXT: "{code}-{code}" })).toBe("111111-111111");
  });

  it("keeps the default for a blank template", () => {
    expect(buildOtpText(CODE, { SMS_OTP_TEXT: "   " })).toBe(buildOtpText(CODE));
  });
});

describe("FourJawalyProvider live wire contract", () => {
  it("posts the observed 4jawaly message envelope with Basic auth and resolves on the live success shape", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    const sender = fourJawaly(fetchImpl);

    await sender.send({ to: TO, code: CODE });

    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.url).toBe("https://api-sms.4jawaly.com/api/v1/account/area/sms/send");
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(request.init.cache).toBe("no-store");
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("accept-language")).toBe("ar");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe(
      "Basic " + Buffer.from("test-key:test-secret", "utf8").toString("base64"),
    );
    expect(request.body).toEqual({
      messages: [
        {
          text: buildOtpText(CODE),
          numbers: ["966564106506"],
          number_iso: "SA",
          sender: "BedBank",
        },
      ],
    });
    // The wire number is international digits without "+".
    expect(JSON.stringify(request.body)).not.toContain("+966");
  });

  it("uses the approved SMS_OTP_TEXT template in the message body", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    await fourJawaly(fetchImpl, { otpText: "كود دخولك: {code}" }).send({ to: TO, code: CODE });
    expect(calls[0]?.body).toEqual({
      messages: [
        { text: "كود دخولك: 123456", numbers: ["966564106506"], number_iso: "SA", sender: "BedBank" },
      ],
    });
  });

  it("accepts the observed HTTP 200 envelope with every message clean", async () => {
    const payload = {
      ...LIVE_SUCCESS,
      messages: [
        { success_count: 2, error_count: 0 },
        { success_count: 1, error_count: 0 },
      ],
    };
    const { fetchImpl } = installFakeFetch(jsonResponse(payload));
    await expect(fourJawaly(fetchImpl).send({ to: TO, code: CODE })).resolves.toBeUndefined();
  });

  it("maps the observed HTTP 400 bad-credentials response to the opaque 502", async () => {
    const body = {
      code: 400,
      message: "provider body must never leak",
      is_token_expired: true,
      request_id: "request-leak-1",
    };
    const { fetchImpl } = installFakeFetch(jsonResponse(body, 400));
    const error = await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
    expect(error.message).toBe(PROVIDER_MESSAGE);
    expect(error.message).not.toContain("provider body must never leak");
    expect(error.message).not.toContain("request-leak-1");
    expect(error.message).not.toContain(CODE);
  });

  it("rejects HTTP 200 envelopes whose own code is not 200", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ code: 400, message: "rejected" }));
    await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
  });

  it("rejects an envelope with a per-message error even on HTTP 200", async () => {
    const payload = {
      code: 200,
      messages: [{ success_count: 0, error_count: 1 }],
    };
    const { fetchImpl } = installFakeFetch(jsonResponse(payload));
    await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
  });

  it("rejects an empty messages array and non-object envelopes", async () => {
    for (const payload of [{ code: 200, messages: [] }, null, [], "ok", { code: "200", messages: [] }]) {
      const { fetchImpl } = installFakeFetch(jsonResponse(payload));
      await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
    }
  });

  it("rejects a non-JSON 2xx body", async () => {
    const { fetchImpl } = installFakeFetch(textResponse("<html>gateway maintenance</html>"));
    await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
  });

  it("caps and cancels a huge 2xx body instead of buffering it", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(40 * 1024)));
        controller.enqueue(encoder.encode("x".repeat(40 * 1024)));
        // Intentionally left open: the provider must cancel the remaining body
        // as soon as the cap is crossed instead of draining it.
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchImpl } = installFakeFetch(new Response(stream, { status: 200 }));
    await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
    expect(cancelled).toBe(true);
  });

  it("honours the SMS_ENDPOINT override for the live provider", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    await fourJawaly(fetchImpl, { endpoint: "https://sms-proxy.example/4jawaly" }).send({
      to: TO,
      code: CODE,
    });
    expect(calls[0]?.url).toBe("https://sms-proxy.example/4jawaly");
  });
});

describe("TaqnyatProvider wire contract", () => {
  it("posts recipients in international digits, the text body and a Bearer token", async () => {
    const { fetchImpl, calls } = installFakeFetch(
      jsonResponse({ statusCode: 200, message: "accepted" }),
    );
    await taqnyat(fetchImpl).send({ to: TO, code: CODE });
    const request = calls[0]!;
    expect(request.url).toBe("https://api.taqnyat.sa/v1/messages");
    expect(request.headers.get("authorization")).toBe("Bearer taqnyat-token");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.body).toEqual({
      recipients: ["966564106506"],
      body: buildOtpText(CODE),
      sender: "BedBank",
    });
  });

  it("fails when a 2xx body carries a non-2xx JSON statusCode", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ statusCode: 401, message: "denied" }));
    await expectProviderFailure(() => taqnyat(fetchImpl).send({ to: TO, code: CODE }));
  });

  it("keeps a plain 2xx response as success (no statusCode field)", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ message: "ok" }));
    await expect(taqnyat(fetchImpl).send({ to: TO, code: CODE })).resolves.toBeUndefined();
    const nonJson = installFakeFetch(textResponse("OK"));
    await expect(taqnyat(nonJson.fetchImpl).send({ to: TO, code: CODE })).resolves.toBeUndefined();
  });

  it("maps non-2xx responses to the same opaque 502", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ statusCode: 200, message: "queued" }, 500));
    await expectProviderFailure(() => taqnyat(fetchImpl).send({ to: TO, code: CODE }));
  });
});

describe("UnifonicProvider wire contract", () => {
  it("posts AppSid, SenderID, international Recipient and Body without an Authorization header", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ success: true, message: "queued" }));
    await unifonic(fetchImpl).send({ to: TO, code: CODE });
    const request = calls[0]!;
    expect(request.url).toBe("https://el.cloud.unifonic.com/rest/SMS/messages");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.body).toEqual({
      AppSid: "unifonic-app-sid",
      SenderID: "BedBank",
      Recipient: "966564106506",
      Body: buildOtpText(CODE),
    });
  });

  it("fails on success:false and on non-2xx", async () => {
    const rejected = installFakeFetch(jsonResponse({ success: false, message: "invalid app sid" }));
    await expectProviderFailure(() => unifonic(rejected.fetchImpl).send({ to: TO, code: CODE }));

    const httpError = installFakeFetch(jsonResponse({ success: false }, 503));
    await expectProviderFailure(() => unifonic(httpError.fetchImpl).send({ to: TO, code: CODE }));
  });

  it("keeps a 2xx response with no success flag as success", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ message: "ok" }));
    await expect(unifonic(fetchImpl).send({ to: TO, code: CODE })).resolves.toBeUndefined();
  });
});

describe("GenericHttpProvider legacy contract", () => {
  it("posts the legacy to/code body with the verbatim Authorization header", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    const sender = generic(fetchImpl, { authorization: "Bearer legacy-provider-token" });
    await sender.send({ to: TO, code: CODE });
    const request = calls[0]!;
    expect(request.url).toBe("https://sms.example/send");
    expect(request.init.redirect).toBe("error");
    expect(request.init.cache).toBe("no-store");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer legacy-provider-token");
    expect(request.body).toEqual({ to: TO, code: CODE });
  });

  it("omits the Authorization header when the gateway needs none", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    await generic(fetchImpl).send({ to: TO, code: CODE });
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("maps a rejecting gateway to the opaque 502 without echoing its body", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse({ error: "internal gateway detail" }, 500));
    const error = await expectProviderFailure(() => generic(fetchImpl).send({ to: TO, code: CODE }));
    expect(error.message).not.toContain("internal gateway detail");
    expect(error.message).not.toContain(CODE);
  });
});

describe("endpoint policy (https, loopback http only outside production)", () => {
  it("accepts https everywhere and plain http on loopback outside production", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    const loopback = new GenericHttpProvider({
      endpoint: " http://127.0.0.1:3999/ ",
      nodeEnv: "test",
      fetchImpl,
    });
    await loopback.send({ to: TO, code: CODE });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3999/");

    const localhost = new GenericHttpProvider({
      endpoint: "http://localhost:3999/send",
      nodeEnv: "development",
      fetchImpl,
    });
    await localhost.send({ to: TO, code: CODE });
    expect(calls[1]?.url).toBe("http://localhost:3999/send");
  });

  it("rejects insecure, credentialed, malformed and production loopback endpoints as config errors", () => {
    const acrossTable: [string | undefined, string][] = [
      [undefined, "test"],
      ["", "test"],
      ["   ", "test"],
      ["not a url", "test"],
      ["ftp://sms.example/send", "test"],
      ["http://sms.example/send", "test"],
      ["https://user:pass@sms.example/send", "test"],
      ["http://127.0.0.1:3999/", "production"],
      ["http://localhost:3999/", "production"],
    ];
    for (const [endpoint, nodeEnv] of acrossTable) {
      expectConfigError(
        () => new GenericHttpProvider({ endpoint, nodeEnv, fetchImpl: fakeFetchThatMustNotBeCalled() }),
        String(endpoint) + " / " + nodeEnv,
      );
    }
  });
});

/** Fails the test if a provider touches the network. */
function fakeFetchThatMustNotBeCalled(): typeof fetch {
  return (async () => {
    throw new Error("the network must not be called");
  }) as typeof fetch;
}

describe("shared wire hardening", () => {
  it("documents the ten second deadline", () => {
    expect(SMS_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled gateway at the injected deadline", async () => {
    let aborted = false;
    let signalAborted = false;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            signalAborted = signal.aborted;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    const started = Date.now();
    await expectProviderFailure(() =>
      fourJawaly(fetchImpl, { timeoutMs: 25 }).send({ to: TO, code: CODE }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(signalAborted).toBe(true);
  });

  it("maps a DNS/connect failure to the opaque 502", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND sms.invalid");
    }) as typeof fetch;
    const error = await expectProviderFailure(() => fourJawaly(fetchImpl).send({ to: TO, code: CODE }));
    expect(error.message).not.toContain("ENOTFOUND");
  });

  it("refuses a redirect status instead of replaying the code", async () => {
    const { fetchImpl, calls } = installFakeFetch(
      new Response(null, { status: 307, headers: { location: "https://evil.example/collect" } }),
    );
    await expectProviderFailure(() => generic(fetchImpl).send({ to: TO, code: CODE }));
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("refuses a payload outside the route contract before any network call", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const senders = allProviders(fetchImpl);
    const invalidTo = ["0501234567", "+12025550143", "+447700900123", "+9665012345", "+9665012345678", "", "966564106506"];
    for (const sender of senders) {
      for (const to of invalidTo) {
        await expectProviderFailure(() => sender.send({ to, code: CODE }));
      }
    }
    expect(calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a malformed code before any network call", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    const malformed = ["12", "1234567", "abcdef", "", "12345a"];
    for (const sender of allProviders(fetchImpl)) {
      for (const code of malformed) {
        await expectProviderFailure(() => sender.send({ to: TO, code }));
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts the documented Saudi E.164 form and the observed boundary numbers", async () => {
    const { fetchImpl } = installFakeFetch(jsonResponse(LIVE_SUCCESS));
    await expect(fourJawaly(fetchImpl).send({ to: "+966500000000", code: "000000" })).resolves.toBeUndefined();
  });
});

describe("createSmsSender provider selection", () => {
  it("builds the sender named by SMS_PROVIDER", () => {
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: "4jawaly", SMS_API_KEY: "key", SMS_API_SECRET: "secret", SMS_SENDER_ID: "BedBank" }).name).toBe("4jawaly");
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: "taqnyat", SMS_API_KEY: "key", SMS_SENDER_ID: "BedBank" }).name).toBe("taqnyat");
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: "unifonic", SMS_API_KEY: "key", SMS_SENDER_ID: "BedBank" }).name).toBe("unifonic");
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: "generic", SMS_ENDPOINT: "https://sms.example/send" }).name).toBe("generic");
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: "mock" })).toBeInstanceOf(MockDevProvider);
    // Provider values are trimmed/normalized so a stray space cannot break production.
    expect(createSmsSender({ NODE_ENV: "test", SMS_PROVIDER: " 4Jawaly ", SMS_API_KEY: "key", SMS_API_SECRET: "secret", SMS_SENDER_ID: "BedBank" }).name).toBe("4jawaly");
  });

  it("treats a blank SMS_ENDPOINT as unset so providers keep their documented defaults", async () => {
    const { fetchImpl, calls } = installFakeFetch((request) => {
      if (request.url.includes("4jawaly")) return jsonResponse(LIVE_SUCCESS);
      return jsonResponse({ statusCode: 200, success: true });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const shared = { NODE_ENV: "test", SMS_ENDPOINT: "" };
    await createSmsSender({
      ...shared,
      SMS_PROVIDER: "4jawaly",
      SMS_API_KEY: "key",
      SMS_API_SECRET: "secret",
      SMS_SENDER_ID: "BedBank",
    }).send({ to: TO, code: CODE });
    await createSmsSender({
      ...shared,
      SMS_PROVIDER: "taqnyat",
      SMS_API_KEY: "key",
      SMS_SENDER_ID: "BedBank",
    }).send({ to: TO, code: CODE });
    await createSmsSender({
      ...shared,
      SMS_PROVIDER: "unifonic",
      SMS_API_KEY: "key",
      SMS_SENDER_ID: "BedBank",
    }).send({ to: TO, code: CODE });
    expect(calls.map((request) => request.url)).toEqual([
      "https://api-sms.4jawaly.com/api/v1/account/area/sms/send",
      "https://api.taqnyat.sa/v1/messages",
      "https://el.cloud.unifonic.com/rest/SMS/messages",
    ]);
  });

  it("keeps the legacy OTP_PROVIDER=http wire shape and precedence", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const sender = createSmsSender({
      NODE_ENV: "test",
      OTP_PROVIDER: "http",
      OTP_HTTP_URL: "https://legacy.example/send",
      OTP_HTTP_AUTHORIZATION: "Bearer legacy-verbatim",
      // A fully configured new provider must NOT win over the legacy variable.
      SMS_PROVIDER: "4jawaly",
      SMS_API_KEY: "key",
      SMS_API_SECRET: "secret",
      SMS_SENDER_ID: "BedBank",
    });
    expect(sender).toBeInstanceOf(GenericHttpProvider);
    expect(sender.name).toBe("generic");
    await sender.send({ to: TO, code: CODE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://legacy.example/send");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer legacy-verbatim");
    // Legacy gateways receive the raw code, not the rendered SMS text.
    expect(calls[0]?.body).toEqual({ to: TO, code: CODE });
  });

  it("builds the new generic sender with Bearer SMS_API_KEY", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const sender = createSmsSender({
      NODE_ENV: "test",
      SMS_PROVIDER: "generic",
      SMS_ENDPOINT: "https://sms.example/send",
      SMS_API_KEY: "generic-key",
    });
    await sender.send({ to: TO, code: CODE });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer generic-key");
    expect(calls[0]?.body).toEqual({ to: TO, code: CODE });
  });

  it("lets an empty OTP_PROVIDER fall through to SMS_PROVIDER", () => {
    for (const legacy of ["", "   "]) {
      expect(createSmsSender({ NODE_ENV: "test", OTP_PROVIDER: legacy, SMS_PROVIDER: "mock" })).toBeInstanceOf(
        MockDevProvider,
      );
    }
  });

  it("maps legacy OTP_PROVIDER=fake to the dev mock outside production", () => {
    expect(createSmsSender({ NODE_ENV: "test", OTP_PROVIDER: "fake" })).toBeInstanceOf(MockDevProvider);
    expect(createSmsSender({ NODE_ENV: "development", OTP_PROVIDER: "fake" }).name).toBe("mock");
  });
});

describe("configuration fails closed", () => {
  const cases: [string, Record<string, string | undefined>][] = [
    ["no provider configured", {}],
    ["unknown SMS_PROVIDER", { SMS_PROVIDER: "twilio" }],
    ["unknown legacy provider wins and fails closed", { OTP_PROVIDER: "sendgrid", SMS_PROVIDER: "mock" }],
    ["4jawaly missing credentials", { SMS_PROVIDER: "4jawaly" }],
    ["4jawaly missing key", { SMS_PROVIDER: "4jawaly", SMS_API_SECRET: "secret", SMS_SENDER_ID: "BedBank" }],
    ["4jawaly missing secret", { SMS_PROVIDER: "4jawaly", SMS_API_KEY: "key", SMS_SENDER_ID: "BedBank" }],
    ["4jawaly missing sender", { SMS_PROVIDER: "4jawaly", SMS_API_KEY: "key", SMS_API_SECRET: "secret" }],
    ["taqnyat missing key", { SMS_PROVIDER: "taqnyat", SMS_SENDER_ID: "BedBank" }],
    ["taqnyat missing sender", { SMS_PROVIDER: "taqnyat", SMS_API_KEY: "key" }],
    ["unifonic missing key", { SMS_PROVIDER: "unifonic", SMS_SENDER_ID: "BedBank" }],
    ["unifonic missing sender", { SMS_PROVIDER: "unifonic", SMS_API_KEY: "key" }],
    ["generic missing endpoint", { SMS_PROVIDER: "generic" }],
    ["generic malformed endpoint", { SMS_PROVIDER: "generic", SMS_ENDPOINT: "not a url" }],
    ["generic insecure endpoint", { SMS_PROVIDER: "generic", SMS_ENDPOINT: "http://sms.example/send" }],
    ["generic credentialed endpoint", { SMS_PROVIDER: "generic", SMS_ENDPOINT: "https://user:pass@sms.example/send" }],
    ["legacy http missing url", { OTP_PROVIDER: "http" }],
    ["legacy http insecure url", { OTP_PROVIDER: "http", OTP_HTTP_URL: "http://sms.example/send" }],
    [
      "SMS_OTP_TEXT without {code}",
      {
        SMS_PROVIDER: "4jawaly",
        SMS_API_KEY: "key",
        SMS_API_SECRET: "secret",
        SMS_SENDER_ID: "BedBank",
        SMS_OTP_TEXT: "بدون رمز",
      },
    ],
  ];

  for (const [label, env] of cases) {
    it(label, () => {
      expectConfigError(() => createSmsSender({ NODE_ENV: "test", ...env }), label);
    });
  }

  it("rejects provider constructors configured with missing credentials", () => {
    expectConfigError(
      () => new FourJawalyProvider({ apiKey: "", apiSecret: "secret", sender: "BedBank", nodeEnv: "test" }),
    );
    expectConfigError(
      () => new FourJawalyProvider({ apiKey: "key", apiSecret: "", sender: "BedBank", nodeEnv: "test" }),
    );
    expectConfigError(
      () => new FourJawalyProvider({ apiKey: "key", apiSecret: "secret", sender: "", nodeEnv: "test" }),
    );
    expectConfigError(() => new TaqnyatProvider({ apiKey: "", sender: "BedBank", nodeEnv: "test" }));
    expectConfigError(() => new TaqnyatProvider({ apiKey: "key", sender: "", nodeEnv: "test" }));
    expectConfigError(() => new UnifonicProvider({ apiKey: "", sender: "BedBank", nodeEnv: "test" }));
    expectConfigError(() => new UnifonicProvider({ apiKey: "key", sender: "", nodeEnv: "test" }));
    expectConfigError(() => new GenericHttpProvider({ nodeEnv: "test" }));
  });

  it("rejects an invalid deadline instead of silently using it", () => {
    expectConfigError(
      () =>
        new FourJawalyProvider({
          apiKey: "key",
          apiSecret: "secret",
          sender: "BedBank",
          nodeEnv: "test",
          timeoutMs: 0,
        }),
    );
  });
});

describe("production fail-closed policy", () => {
  it("rejects mock/fake, loopback http and legacy-insecure configuration", () => {
    const cases: Record<string, string | undefined>[] = [
      { SMS_PROVIDER: "mock" },
      { OTP_PROVIDER: "fake" },
      { SMS_PROVIDER: "generic", SMS_ENDPOINT: "http://127.0.0.1:3999/" },
      { OTP_PROVIDER: "http", OTP_HTTP_URL: "http://localhost:3999/" },
    ];
    for (const env of cases) {
      expectConfigError(() => createSmsSender({ NODE_ENV: "production", ...env }), JSON.stringify(env));
    }
    expect(() => new MockDevProvider({ nodeEnv: "production" })).toThrow(AppError);
  });

  it("accepts the real providers in production when their configuration is complete", () => {
    expect(
      createSmsSender({
        NODE_ENV: "production",
        SMS_PROVIDER: "4jawaly",
        SMS_API_KEY: "key",
        SMS_API_SECRET: "secret",
        SMS_SENDER_ID: "BedBank",
      }).name,
    ).toBe("4jawaly");
    expect(
      createSmsSender({ NODE_ENV: "production", SMS_PROVIDER: "taqnyat", SMS_API_KEY: "key", SMS_SENDER_ID: "BedBank" }).name,
    ).toBe("taqnyat");
    expect(
      createSmsSender({
        NODE_ENV: "production",
        SMS_PROVIDER: "unifonic",
        SMS_API_KEY: "key",
        SMS_SENDER_ID: "BedBank",
      }).name,
    ).toBe("unifonic");
    expect(
      createSmsSender({
        NODE_ENV: "production",
        SMS_PROVIDER: "generic",
        SMS_ENDPOINT: "https://sms.example/send",
      }).name,
    ).toBe("generic");
    expect(
      createSmsSender({
        NODE_ENV: "production",
        OTP_PROVIDER: "http",
        OTP_HTTP_URL: "https://sms.example/send",
      }).name,
    ).toBe("generic");
  });

  it("accepts a blank SMS_ENDPOINT in production when the provider has a documented default", () => {
    expect(
      createSmsSender({
        NODE_ENV: "production",
        SMS_PROVIDER: "4jawaly",
        SMS_API_KEY: "key",
        SMS_API_SECRET: "secret",
        SMS_SENDER_ID: "BedBank",
        SMS_ENDPOINT: "",
      }).name,
    ).toBe("4jawaly");
  });

  it("honours the SMS_ENDPOINT loopback policy through the factory", () => {
    const creds = { SMS_PROVIDER: "4jawaly", SMS_API_KEY: "key", SMS_API_SECRET: "secret", SMS_SENDER_ID: "BedBank" };
    expect(
      createSmsSender({ NODE_ENV: "test", ...creds, SMS_ENDPOINT: "http://127.0.0.1:3999/send" }).name,
    ).toBe("4jawaly");
    expectConfigError(() =>
      createSmsSender({ NODE_ENV: "production", ...creds, SMS_ENDPOINT: "http://127.0.0.1:3999/send" }),
    );
  });
});

describe("provider names", () => {
  it("matches the documented SmsSender name union", () => {
    const fetchImpl = fakeFetchThatMustNotBeCalled();
    expect(allProviders(fetchImpl).map((sender) => sender.name)).toEqual([
      "4jawaly",
      "taqnyat",
      "unifonic",
      "generic",
      "mock",
    ]);
  });
});

describe("blank NODE_ENV fails closed as production", () => {
  it("refuses the dev mock when NODE_ENV is blank or whitespace", () => {
    for (const nodeEnv of ["", "   "]) {
      expectConfigError(() => createSmsSender({ NODE_ENV: nodeEnv, SMS_PROVIDER: "mock" }));
    }
  });

  it("refuses a loopback plain-http gateway when NODE_ENV is blank", () => {
    expectConfigError(() =>
      createSmsSender({ NODE_ENV: "", SMS_PROVIDER: "generic", SMS_ENDPOINT: "http://127.0.0.1:3999/" }),
    );
  });

  it("still builds a fully configured real provider when NODE_ENV is blank", () => {
    expect(
      createSmsSender({
        NODE_ENV: "",
        SMS_PROVIDER: "4jawaly",
        SMS_API_KEY: "key",
        SMS_API_SECRET: "secret",
        SMS_SENDER_ID: "BedBank",
      }).name,
    ).toBe("4jawaly");
  });
});

describe("generic gateway legacy URL fallback", () => {
  it("uses OTP_HTTP_URL when SMS_ENDPOINT is blank for SMS_PROVIDER=generic", async () => {
    const { fetchImpl, calls } = installFakeFetch(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const sender = createSmsSender({
      NODE_ENV: "test",
      SMS_PROVIDER: "generic",
      SMS_ENDPOINT: " ",
      OTP_HTTP_URL: "https://legacy.example/send",
    });
    expect(sender).toBeInstanceOf(GenericHttpProvider);
    await sender.send({ to: TO, code: CODE });
    expect(calls[0]?.url).toBe("https://legacy.example/send");
    expect(calls[0]?.body).toEqual({ to: TO, code: CODE });
  });
});
