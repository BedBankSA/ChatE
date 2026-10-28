"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { issueTurnstileToken } from "@/components/turnstile";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const RETRY = "تعذر التحقق الأمني. أعد المحاولة.";

type CredentialResponse = { credential?: string };

type GoogleId = {
  initialize: (config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    nonce: string;
    ux_mode: "popup";
    auto_select: false;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, string | number>) => void;
};

declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

let warmed: Promise<string> | null = null;
let googleScriptTask: Promise<void> | null = null;
let mountedHost: HTMLElement | null = null;

function warmLoginTurnstile(): Promise<string> {
  if (warmed) return warmed;
  const pending = issueTurnstileToken("login");
  warmed = pending;
  pending.catch(() => {
    if (warmed === pending) warmed = null;
  });
  return pending;
}

async function takeLoginTurnstile(): Promise<string> {
  const pending = warmLoginTurnstile();
  try {
    return await pending;
  } finally {
    if (warmed === pending) warmed = null;
  }
}

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptTask) return googleScriptTask;
  const pending = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src^="https://accounts.google.com/gsi/client"]');
    if (existing) {
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("google-script")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("google-script"));
    document.head.appendChild(script);
  });
  googleScriptTask = pending;
  pending.catch(() => {
    if (googleScriptTask === pending) googleScriptTask = null;
  });
  return pending;
}

async function fetchNonce(): Promise<string> {
  const response = await fetch("/api/auth/google/intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json()) as { data?: { nonce?: string }; error?: { message?: string } };
  if (!response.ok || !body.data?.nonce) throw new Error(body.error?.message || "nonce");
  return body.data.nonce;
}

export function GoogleIntentButton() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const router = useRouter();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const buttonHost: HTMLElement = host;
    let active = true;
    const report = (text: string) => {
      if (active) setMessage(text);
    };

    async function finish(credential: string | undefined) {
      if (!credential) {
        setMessage("لم يصل رمز Google.");
        return;
      }
      let turnstileToken = "";
      try {
        turnstileToken = await takeLoginTurnstile();
      } catch {
        setMessage(RETRY);
        return;
      }
      try {
        const response = await fetch("/api/auth/google", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential, "cf-turnstile-response": turnstileToken }),
        });
        const body = (await response.json()) as {
          data?: { name?: string };
          error?: { message?: string };
        };
        if (!response.ok) {
          setMessage(body.error?.message ?? "تعذر إكمال الدخول");
          return;
        }
        setMessage(`تم الدخول: ${body.data?.name || "حساب Google"}`);
        router.push("/profile/complete");
        router.refresh();
      } catch {
        setMessage("تعذر إكمال الدخول");
      }
    }

    async function mountOfficialButton() {
      if (!CLIENT_ID) {
        report("دخول Google ينتظر معرّف العميل.");
        return;
      }
      if (mountedHost === buttonHost || mountedHost?.isConnected) return;
      mountedHost = buttonHost;
      try {
        const [nonce] = await Promise.all([fetchNonce(), loadGoogleScript()]);
        if (mountedHost !== buttonHost || !buttonHost.isConnected || buttonHost.childElementCount > 0) return;
        const googleId = window.google?.accounts.id;
        if (!googleId) {
          if (mountedHost === buttonHost) mountedHost = null;
          report("تعذر تحميل زر Google.");
          return;
        }
        googleId.initialize({
          client_id: CLIENT_ID,
          nonce,
          ux_mode: "popup",
          auto_select: false,
          callback: (response) => {
            void finish(response.credential);
          },
        });
        googleId.renderButton(buttonHost, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          locale: "ar",
          logo_alignment: "left",
          width: 320,
        });
      } catch {
        if (mountedHost === buttonHost) mountedHost = null;
        report("تعذر بدء الدخول");
      }
    }

    void mountOfficialButton();

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div style={{ display: "grid", gap: "0.5rem", width: "fit-content" }}>
      <div ref={hostRef} id="google-signin-button" dir="ltr" style={{ display: "inline-block", minHeight: 44 }} />
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
