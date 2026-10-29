"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { issueTurnstileToken } from "@/components/turnstile";

type Mode = "initial" | "change";
type Phase = "phone" | "code" | "done";

type OtpResponse = {
  data?: {
    sent?: boolean;
    verified?: boolean;
    expiresInSeconds?: number;
    cooldownSeconds?: number;
    change?: boolean;
    targetPhone?: string;
  };
  error?: { message?: string; code?: string; remainingAttempts?: number; retryAfterSeconds?: number };
};

const SECURITY_RETRY = "تعذر التحقق الأمني. أعد المحاولة.";
const SECURITY_UNCONFIGURED = "التحقق الأمني غير مهيأ على هذا الخادم. تواصل مع الدعم لإكمال التفعيل.";
const FALLBACK_SEND = "تعذر إرسال رمز التحقق.";
const FALLBACK_VERIFY = "تعذر تأكيد الرمز.";
const DEFAULT_COOLDOWN_SECONDS = 60;
const NOT_CONFIGURED = "مزود الرسائل غير مهيأ على هذا الخادم، لذلك لا يمكن إرسال رمز الآن. تواصل مع الدعم.";

async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; body: OtpResponse }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as OtpResponse;
  return { ok: response.ok, body: payload };
}

/**
 * The single phone flow used by /verify-phone (initial activation) and by the
 * customer dashboard (changing a number after verification).
 *
 * Zero dead ends: the OTP step always offers "edit phone" and a live resend
 * countdown, and every server error keeps the customer on a step they can act
 * on instead of a blank refusal.
 */
export function PhoneVerification({
  mode,
  initialPhone,
  nextPath,
  smsConfigured,
}: {
  mode: Mode;
  initialPhone: string | null;
  nextPath: string;
  smsConfigured: boolean;
}) {
  const router = useRouter();
  const [active, setActive] = useState(mode === "initial");
  const [phase, setPhase] = useState<Phase>("phone");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [sentTo, setSentTo] = useState(initialPhone ?? "");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"status" | "error">("status");
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // One-second countdown for the resend button; the authoritative cap is still
  // the SQLite-backed 3-per-15-minutes check on the server.
  useEffect(() => {
    if (!cooldownUntil) return;
    // The first value is set by startCooldown; this interval only ticks down.
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setCooldownUntil(0);
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  function startCooldown(seconds: number) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 15 * 60) : DEFAULT_COOLDOWN_SECONDS;
    setSecondsLeft(safe);
    setCooldownUntil(Date.now() + safe * 1000);
  }

  async function requestCode() {
    if (!smsConfigured) {
      setTone("error");
      setMessage(NOT_CONFIGURED);
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const token = await issueTurnstileToken("otp");
      // The server reads the single-use Turnstile token from the JSON body only
      // (src/server/guard.ts gateTurnstile -> readTurnstileToken); omitting it
      // makes every activation attempt fail with 403.
      const result = await postJson("/api/otp/send", { phone, "cf-turnstile-response": token });
      if (!result.ok) {
        const error = result.body.error;
        if (error?.retryAfterSeconds) startCooldown(error.retryAfterSeconds);
        setTone("error");
        setMessage(error?.message ?? FALLBACK_SEND);
        return;
      }
      if (result.body.data?.verified) {
        setPhase("done");
        setTone("status");
        setMessage("جوالك موثّق بالفعل.");
        router.refresh();
        return;
      }
      const target = result.body.data?.targetPhone ?? phone;
      setSentTo(target);
      startCooldown(result.body.data?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS);
      setPhase("code");
      setCode("");
      setTone("status");
      const minutes = Math.max(1, Math.round((result.body.data?.expiresInSeconds ?? 300) / 60));
      setMessage(`أُرسل رمز من ٦ أرقام إلى ${target}. أدخله خلال ${minutes} دقائق.`);
    } catch (error) {
      setTone("error");
      setMessage(error instanceof Error && error.message.includes("sitekey") ? SECURITY_UNCONFIGURED : SECURITY_RETRY);
    } finally {
      setPending(false);
    }
  }

  async function confirmCode() {
    setPending(true);
    setMessage("");
    try {
      const result = await postJson("/api/otp/verify", { code });
      if (!result.ok) {
        const error = result.body.error;
        const suffix = error?.remainingAttempts == null ? "" : ` المحاولات المتبقية: ${error.remainingAttempts}.`;
        setTone("error");
        setMessage(`${error?.message ?? FALLBACK_VERIFY}${suffix}`);
        return;
      }
      setPhase("done");
      setTone("status");
      setMessage(mode === "change" ? "تم توثيق رقم الجوال الجديد بنجاح." : "تم توثيق جوالك بنجاح.");
      router.refresh();
    } catch {
      setTone("error");
      setMessage(FALLBACK_VERIFY);
    } finally {
      setPending(false);
    }
  }

  if (phase === "done") {
    return (
      <section className="verify-panel" aria-label="حالة توثيق الجوال">
        <p role={tone === "error" ? "alert" : "status"}>{message}</p>
        {mode === "initial" ? (
          <button
            className="btn"
            type="button"
            onClick={() => {
              router.push(nextPath);
              router.refresh();
            }}
          >
            متابعة إلى مساحة العمل
          </button>
        ) : (
          <button
            className="btn"
            type="button"
            onClick={() => {
              setActive(false);
              setPhase("phone");
              setMessage("");
              router.refresh();
            }}
          >
            العودة إلى بيانات الحساب
          </button>
        )}
      </section>
    );
  }

  if (mode === "change" && !active) {
    return (
      <section className="verify-panel" aria-label="تغيير رقم الجوال">
        <p className="meta">
          رقمك الحالي موثّق. عند إدخال رقم جديد نرسل رمز تحقق إليه، ولا يُستبدل الرقم الحالي إلا بعد نجاح الرمز.
        </p>
        <button className="btn secondary" type="button" onClick={() => setActive(true)}>
          تغيير رقم الجوال
        </button>
      </section>
    );
  }

  return (
    <form
      className="verify-panel stack-form"
      aria-label={mode === "change" ? "تغيير رقم الجوال" : "تفعيل رقم الجوال"}
      onSubmit={(event) => {
        event.preventDefault();
        if (phase === "phone") void requestCode();
        else void confirmCode();
      }}
    >
      {/* Persistent live regions (created empty, then filled) so screen readers
          announce OTP errors and successes; a region that is created together
          with its text is not reliably announced. */}
      <p className="sr-only" role="alert">{tone === "error" ? message : ""}</p>
      <p className="sr-only" role="status">{tone === "error" ? "" : message}</p>
      {!smsConfigured ? (
        <p className="ws-notice ws-notice-error" role="status">
          مزود الرسائل غير مهيأ على هذا الخادم. لن يصل رمز SMS حتى يضبط المشغّل مزود الإرسال.
        </p>
      ) : null}
      {phase === "phone" ? (
        <>
          <label className="field-label">
            رقم الجوال
            <input
              className="field"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              placeholder="05xxxxxxxx"
              aria-label="رقم الجوال"
              aria-describedby="phone-hint"
              dir="ltr"
              disabled={pending}
              required
            />
          </label>
          <p id="phone-hint" className="meta">
            أدخل رقم جوالك بأي صيغة (05…، 5…، +966…، 00966… أو أرقام عربية). يُوحَّد الرقم تلقائيًا إلى ‎+9665XXXXXXXX.
          </p>
          {mode === "change" ? (
            <button className="btn secondary" type="button" disabled={pending} onClick={() => setActive(false)}>
              إلغاء التغيير
            </button>
          ) : null}
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "جارٍ الإرسال..." : "إرسال رمز التحقق"}
          </button>
        </>
      ) : (
        <>
          <p className="meta">
            الرمز أُرسل إلى <span className="ltr">{sentTo}</span>.
          </p>
          <label className="field-label">
            رمز التحقق
            <input
              className="field"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              aria-label="رمز التحقق المكوّن من ستة أرقام"
              dir="ltr"
              maxLength={6}
              pattern="[0-9]*"
              disabled={pending}
              required
              aria-invalid={tone === "error" ? true : undefined}
              aria-describedby="otp-code-help"
            />
          </label>
          <p id="otp-code-help" className="meta">أدخل الرمز المكوّن من ٦ أرقام الذي وصل برسالة نصية.</p>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "جارٍ التأكيد..." : "تأكيد الرمز"}
          </button>
          <div className="verify-actions">
            <button
              className="btn secondary"
              type="button"
              disabled={pending || secondsLeft > 0}
              onClick={() => void requestCode()}
            >
              {secondsLeft > 0 ? `إعادة الإرسال بعد ${secondsLeft} ثانية` : "إعادة إرسال الرمز"}
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={pending}
              onClick={() => {
                setPhase("phone");
                setCode("");
                setMessage("");
                setTone("status");
              }}
            >
              تعديل رقم الجوال
            </button>
          </div>
        </>
      )}
      {message ? (
        <p className={tone === "error" ? "ws-notice ws-notice-error" : "ws-notice"} aria-hidden="true">
          {message}
        </p>
      ) : null}
    </form>
  );
}
