"use client";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
  isExpired?: (id: string) => boolean;
};

type WidgetRecord = {
  id: string;
  waiters: Array<(token: string | null) => void>;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const widgets = new Map<string, WidgetRecord>();

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("turnstile-browser"));
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]',
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      if (window.turnstile) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("turnstile-script")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    // Wait for onload. The Turnstile ready helper throws when async or defer is set.
    script.async = false;
    script.defer = false;
    script.src = SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile-script"));
    document.head.appendChild(script);
  });
}

function settle(action: string, token: string | null): void {
  const record = widgets.get(action);
  record?.waiters.shift()?.(token);
}

function containerFor(action: string): HTMLElement {
  const id = `turnstile-${action}`;
  const found = document.getElementById(id);
  if (found) return found;
  const element = document.createElement("div");
  element.id = id;
  document.body.appendChild(element);
  return element;
}

export async function issueTurnstileToken(action: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(action)) throw new Error("turnstile-action");
  if (!SITE_KEY) throw new Error("turnstile-sitekey");
  await loadScript();
  const api = window.turnstile;
  if (!api) throw new Error("turnstile-missing");
  let record = widgets.get(action);
  if (!record) {
    const container = containerFor(action);
    const id = api.render(container, {
      sitekey: SITE_KEY,
      action,
      execution: "execute",
      appearance: "interaction-only",
      callback: (token: string) => settle(action, token),
      "error-callback": () => settle(action, null),
      "expired-callback": () => {
        api.reset(id);
        settle(action, null);
      },
    });
    record = { id, waiters: [] };
    widgets.set(action, record);
  }
  const current = record;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      api.reset(current.id);
      reject(new Error("turnstile-timeout"));
    }, 20_000);
    current.waiters.push((token) => {
      window.clearTimeout(timer);
      api.reset(current.id);
      if (token) resolve(token);
      else reject(new Error("turnstile"));
    });
    if (api.isExpired?.(current.id)) api.reset(current.id);
    api.execute(current.id);
  });
}
