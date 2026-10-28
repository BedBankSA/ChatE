"use client";

import Link from "next/link";
import { useState } from "react";
import { issueTurnstileToken } from "@/components/turnstile";

type Step = "phone" | "code" | "done";

type OtpResponse = {
  data?: { sent?: boolean; verified?: boolean; expiresInSeconds?: number };
  error?: { message?: string; code?: string; remainingAttempts?: number };
};

// One consistent UX: a single field that must include the international
// prefix. The server rejects national-only input instead of guessing a country.
const PHONE_HINT = "أدخل الرقم مع مفتاح الدولة في حقل واحد، مثل +966501234567";
const SECURITY_RETRY = "تعذر التحقق الأمني. أعد المحاولة.";
const FALLBACK_SEND = "تعذر إرسال رمز التحقق.";
const FALLBACK_VERIFY = "تعذر تأكيد الرمز.";

export function OtpRequestForm() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; body: OtpResponse }> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as OtpResponse;
    return { ok: response.ok, body: payload };
  }

  async function requestCode() {
    setPending(true);
    setMessage("");
    try {
      const token = await issueTurnstileToken("otp");
      const result = await postJson("/api/otp/send", { phone, "cf-turnstile-response": token });
      if (!result.ok) {
        setMessage(result.body.error?.message ?? FALLBACK_SEND);
        return;
      }
      if (result.body.data?.verified) {
        setStep("done");
        setMessage("جوالك موثّق بالفعل.");
        return;
      }
      const seconds = result.body.data?.expiresInSeconds ?? 300;
      const minutes = Math.max(1, Math.round(seconds / 60));
      setStep("code");
      setCode("");
      setMessage(`أُرسل رمز من ٦ أرقام إلى جوالك. أدخله خلال ${minutes} دقائق.`);
    } catch {
      setMessage(SECURITY_RETRY);
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
        const remaining = error?.remainingAttempts;
        const suffix = remaining == null ? "" : ` المحاولات المتبقية: ${remaining}.`;
        setMessage(`${error?.message ?? FALLBACK_VERIFY}${suffix}`);
        return;
      }
      setStep("done");
      setMessage("تم توثيق جوالك.");
    } catch {
      setMessage(FALLBACK_VERIFY);
    } finally {
      setPending(false);
    }
  }

  if (step === "done") {
    return (
      <section className="stack-form" aria-label="حالة توثيق الجوال">
        <p role="status">{message || "تم توثيق جوالك."}</p>
        <p>يمكنك الآن استخدام النماذج وإرسال المقارنات من مساحة العمل.</p>
        <Link className="btn" href="/workspace">الانتقال إلى مساحة العمل</Link>
      </section>
    );
  }

  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (step === "phone") void requestCode();
        else void confirmCode();
      }}
    >
      {step === "phone" ? (
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
              placeholder="+9665..."
              aria-label="رقم الجوال مع مفتاح الدولة"
              dir="ltr"
              maxLength={20}
              disabled={pending}
              required
            />
          </label>
          <p>{PHONE_HINT}</p>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "جارٍ الإرسال..." : "إرسال رمز التحقق"}
          </button>
        </>
      ) : (
        <>
          <label className="field-label">
            رمز التحقق
            <input
              className="field"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              aria-label="رمز التحقق المكوّن من ستة أرقام"
              dir="ltr"
              maxLength={6}
              pattern="[0-9]*"
              disabled={pending}
              required
            />
          </label>
          <p>أدخل الرمز المكوّن من ٦ أرقام الذي وصل برسالة نصية.</p>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "جارٍ التأكيد..." : "تأكيد الرمز"}
          </button>
          <button className="btn secondary" type="button" disabled={pending} onClick={() => void requestCode()}>
            إعادة الإرسال
          </button>
        </>
      )}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
