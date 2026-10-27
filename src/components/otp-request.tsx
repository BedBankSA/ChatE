"use client";

import { useState } from "react";
import { issueTurnstileToken } from "@/components/turnstile";

export function OtpRequestForm() {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function send() {
    setPending(true);
    setMessage("");
    try {
      const token = await issueTurnstileToken("otp");
      const response = await fetch("/api/otp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, "cf-turnstile-response": token }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      setMessage(body.error?.message ?? "تعذر إرسال الرمز");
    } catch {
      setMessage("تعذر التحقق الأمني. أعد المحاولة.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="field-label">
        رقم الجوال
        <input className="field" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" aria-label="رقم الجوال" />
      </label>
      <button className="btn" type="submit" disabled={pending}>إرسال رمز التحقق</button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
