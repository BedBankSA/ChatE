/**
 * Zero-dependency Chrome DevTools Protocol harness for ChatE QA.
 * Requirements: Node.js 24 (global WebSocket + fetch) and a local Chrome.
 * No npm packages are installed or imported.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME_PATH =
  process.env.QA_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchChrome(options = {}) {
  const port = Number(options.port ?? process.env.QA_CDP_PORT ?? 9222);
  const userDataDir =
    options.userDataDir ?? (await mkdtemp(path.join(tmpdir(), "chate-qa-profile-")));
  const hostResolverRules = options.hostResolverRules ?? process.env.QA_HOST_RESOLVER_RULES ?? "";
  const args = [
    "--headless=new",
    "--remote-allow-origins=*",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + userDataDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--hide-scrollbars",
    "--no-proxy-server",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    "--lang=ar",
    ...(hostResolverRules ? ["--host-resolver-rules=" + hostResolverRules] : []),
    ...(options.extraArgs ?? []),
    "about:blank",
  ];
  const proc = spawn(CHROME_PATH, args, { stdio: "ignore", windowsHide: true });
  const deadline = Date.now() + 30_000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/version", {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      /* keep polling */
    }
    await sleep(200);
  }
  if (!version) {
    killChrome(proc.pid);
    throw new Error("Chrome did not expose CDP on port " + port + " within 30s");
  }
  let pageTarget = await pageTargets(port).then((list) => list.find((item) => item.type === "page"));
  if (!pageTarget) {
    const response = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", {
      method: "PUT",
    });
    pageTarget = await response.json();
  }
  return { proc, port, userDataDir, version, pageTarget };
}

async function pageTargets(port) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    return await response.json();
  } catch {
    return [];
  }
}

export async function stopChrome(chrome) {
  if (!chrome) return;
  killChrome(chrome.proc?.pid);
  if (chrome.userDataDir) {
    await rm(chrome.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

function killChrome(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener("message", (event) => this.#onMessage(event));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  static async connect(webSocketUrl, timeoutMs = 15_000) {
    const ws = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket refused")); }, { once: true });
    });
    return new CDP(ws);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("CDP connection closed during " + entry.method));
    }
    this.pending.clear();
    this.#emit("close", {});
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id != null) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(entry.method + ": " + message.error.message));
      else entry.resolve(message.result ?? {});
      return;
    }
    this.#emit(message.method, message.params ?? {});
  }

  #emit(name, params) {
    const handlers = this.listeners.get(name);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(params);
      } catch {
        /* ignore listener bug */
      }
    }
  }

  on(eventName, handler) {
    const set = this.listeners.get(eventName) ?? new Set();
    set.add(handler);
    this.listeners.set(eventName, set);
    return () => set.delete(handler);
  }

  send(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const timeout = options.timeout ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitEvent(eventName, { timeout = 30_000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("CDP event timeout: " + eventName));
      }, timeout);
      const off = this.on(eventName, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }
}

export class EventCollector {
  constructor(cdp, { baseUrl } = {}) {
    this.cdp = cdp;
    this.base = baseUrl ? new URL(baseUrl) : null;
    this.currentTest = "setup";
    this.entries = [];
    this.documents = [];
    this.requests = new Map();
    this.externalHosts = [
      "accounts.google.com",
      "challenges.cloudflare.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "www.google.com",
    ];
    cdp.on("Runtime.consoleAPICalled", (event) => this.#console(event));
    cdp.on("Runtime.exceptionThrown", (event) => this.#exception(event));
    cdp.on("Log.entryAdded", (event) => this.#log(event));
    cdp.on("Network.responseReceived", (event) => this.#response(event));
    cdp.on("Network.loadingFailed", (event) => this.#failed(event));
    cdp.on("Network.requestWillBeSent", (event) => this.#request(event));
  }

  setTest(id) {
    this.currentTest = id;
  }

  #push(entry) {
    const dedupeKey = [entry.kind, entry.level, entry.url ?? "", (entry.text ?? "").slice(0, 400)].join("|");
    if (this.entries.some((existing) => existing.dedupeKey === dedupeKey)) return;
    this.entries.push({ ...entry, dedupeKey, test: this.currentTest });
  }

  #console(event) {
    const type = event.type ?? "log";
    const level = type === "error" ? "error" : type === "warning" ? "warn" : "info";
    const text = (event.args ?? [])
      .map((arg) => {
        if (arg.value !== undefined) {
          return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
        }
        return arg.description ?? arg.unserializableValue ?? "?";
      })
      .join(" ");
    const frame = event.stackTrace?.callFrames?.[0];
    this.#push({
      kind: "console",
      type,
      level,
      text: text.slice(0, 1000),
      url: frame?.url ?? "",
      line: frame?.lineNumber,
      external: this.#isExternal(frame?.url),
    });
  }

  #exception(event) {
    const details = event.exceptionDetails ?? {};
    const description = details.exception?.description ?? details.text ?? "uncaught exception";
    this.#push({
      kind: "exception",
      level: "error",
      text: String(description).slice(0, 1500),
      url: details.url ?? details.stackTrace?.callFrames?.[0]?.url ?? "",
      line: details.lineNumber,
      external: this.#isExternal(details.url),
    });
  }

  #log(event) {
    const entry = event.entry ?? {};
    this.#push({
      kind: "log",
      level: entry.level ?? "info",
      text: String(entry.text ?? "").slice(0, 1000),
      url: entry.url ?? "",
      line: entry.lineNumber,
      source: entry.source,
      external: this.#isExternal(entry.url),
    });
  }

  #request(event) {
    this.requests.set(event.requestId, {
      url: event.request?.url ?? "",
      method: event.request?.method ?? "GET",
      type: event.type,
      startedAt: Date.now(),
    });
    if (event.type === "Document") {
      this.documents.push({
        url: event.request?.url ?? "",
        method: event.request?.method ?? "GET",
        status: null,
        location: null,
      });
    }
  }

  #response(event) {
    const record = this.requests.get(event.requestId);
    const url = event.response?.url ?? record?.url ?? "";
    const status = event.response?.status ?? 0;
    const type = event.type ?? record?.type ?? "";
    for (let index = this.documents.length - 1; index >= 0; index -= 1) {
      if (this.documents[index].status == null && this.documents[index].url === url) {
        this.documents[index].status = status;
        this.documents[index].location = event.response?.headers?.location;
        break;
      }
    }
    if (status >= 400) {
      const isNoise =
        /favicon\.ico$/.test(url) ||
        /\/_next\/static\/(?:chunks\/)?.*\.map($|\?)/.test(url) ||
        /\/_next\/webpack-hmr/.test(url);
      this.#push({
        kind: "network",
        level: status >= 500 ? "error" : "warn",
        text: "HTTP " + status + " " + type,
        url,
        status,
        external: this.#isExternal(url),
        noise: isNoise,
      });
    }
  }

  #failed(event) {
    const record = this.requests.get(event.requestId);
    const url = record?.url ?? event.url ?? "";
    // The App Router cancels in-flight RSC prefetches whenever a navigation
    // supersedes them; Chrome reports that as ERR_ABORTED. It is expected
    // router behaviour, not an application error.
    const canceledPrefetch = Boolean(event.canceled) && /[?&]_rsc=/.test(url);
    const isNoise =
      canceledPrefetch || /favicon\.ico$/.test(url) || /\/_next\/webpack-hmr/.test(url) || /\.map($|\?)/.test(url);
    this.#push({
      kind: "network-failed",
      level: "error",
      text: "failed: " + (event.errorText ?? "unknown") + (event.canceled ? " (canceled)" : ""),
      url,
      external: this.#isExternal(url),
      noise: isNoise,
    });
  }

  #isExternal(url) {
    if (!url) return false;
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }
    if (this.base && hostname === this.base.hostname) return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return false;
    return this.externalHosts.some((host) => hostname === host || hostname.endsWith("." + host));
  }

  appErrors() {
    return this.entries.filter(
      (entry) =>
        !entry.noise &&
        !entry.external &&
        (entry.kind === "exception" ||
          entry.level === "error" ||
          (entry.kind === "console" && entry.type === "warning")),
    );
  }

  externalNoise() {
    return this.entries.filter((entry) => entry.external);
  }

  networkFailures() {
    return this.entries.filter((entry) => entry.kind === "network" || entry.kind === "network-failed");
  }

  snapshot() {
    return {
      errors: this.appErrors(),
      warnings: this.entries.filter(
        (entry) => entry.kind === "console" && entry.type === "warning" && !entry.external,
      ),
      external: this.externalNoise(),
      network: this.networkFailures(),
      documents: [...this.documents],
    };
  }

  reset() {
    this.entries = [];
    this.documents = [];
    this.requests.clear();
  }
}

export class Page {
  constructor(cdp) {
    this.cdp = cdp;
  }

  async init() {
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("Network.enable"),
      this.cdp.send("Log.enable"),
    ]);
  }

  async addInitScript(source) {
    const { identifier } = await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    return identifier;
  }

  async setViewport(width, height, { mobile = false, deviceScaleFactor = 1 } = {}) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    await this.cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: mobile,
      maxTouchPoints: mobile ? 5 : 1,
    });
  }

  async navigate(url, { timeout = 45_000 } = {}) {
    const loaded = this.cdp.waitEvent("Page.loadEventFired", { timeout, predicate: () => true });
    const result = await this.cdp.send("Page.navigate", { url }, { timeout: 20_000 });
    if (result.errorText) throw new Error("navigation failed: " + result.errorText);
    await loaded.catch(() => {});
    await this.waitFor("document.readyState === 'complete'", { timeout: 20_000 });
    await this.waitFonts();
    return result;
  }

  async waitFor(expression, { timeout = 20_000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastValue;
    let lastError;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.eval(expression, { timeout: Math.max(1000, timeout) });
        if (lastValue) return lastValue;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    const suffix = lastError
      ? " (last error: " + lastError.message + ")"
      : " (last value: " + JSON.stringify(lastValue) + ")";
    throw new Error("waitFor timed out: " + label + suffix);
  }

  async eval(expression, { awaitPromise = true, returnByValue = true, timeout = 20_000 } = {}) {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue, userGesture: true, timeout },
      { timeout: timeout + 5000 },
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description =
        details.exception?.description ?? details.exception?.value ?? details.text ?? "evaluate failed";
      throw new Error(String(description).split("\n")[0]);
    }
    return result.result?.value;
  }

  async click(selector) {
    const clicked = await this.eval(
      "(() => { const element = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!element) return false; element.scrollIntoView({ block: 'center', inline: 'nearest' }); element.click(); return true; })()",
    );
    if (!clicked) throw new Error("click target missing: " + selector);
  }

  async clickByText(selector, text) {
    const clicked = await this.eval(
      "(() => { const wanted = " +
        JSON.stringify(text) +
        "; const element = [...document.querySelectorAll(" +
        JSON.stringify(selector) +
        ")].find((node) => (node.textContent || '').trim() === wanted); if (!element) return false; element.scrollIntoView({ block: 'center', inline: 'nearest' }); element.click(); return true; })()",
    );
    if (!clicked) throw new Error("click target missing: " + selector + ' with text "' + text + '"');
  }

  async fill(selector, value) {
    const filled = await this.eval(
      "(() => { const element = document.querySelector(" +
        JSON.stringify(selector) +
        "); if (!element) return false; const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const descriptor = Object.getOwnPropertyDescriptor(proto, 'value'); descriptor.set.call(element, " +
        JSON.stringify(value) +
        "); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
    );
    if (!filled) throw new Error("fill target missing: " + selector);
  }

  async pressTab(times = 1, pauseMs = 150) {
    for (let index = 0; index < times; index += 1) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
      await sleep(pauseMs);
    }
  }

  async focusInfo() {
    return this.eval(
      "(() => { const element = document.activeElement; if (!element) return null; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), id: element.id || null, className: typeof element.className === 'string' ? element.className : null, role: element.getAttribute('role'), ariaLabel: element.getAttribute('aria-label'), text: (element.textContent || '').trim().slice(0, 80), href: element.getAttribute('href'), outline: style.outlineStyle + ' ' + style.outlineWidth + ' ' + style.outlineColor, boxShadow: style.boxShadow, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, focusVisible: element.matches(':focus-visible') }; })()",
    );
  }

  async waitFonts() {
    await this.eval(
      "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true",
    ).catch(() => {});
  }

  async scrollToTop() {
    await this.eval("window.scrollTo(0, 0); true");
    await sleep(120);
  }

  async reduceMotion() {
    await this.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  }

  async screenshot(filePath, { fullPage = false } = {}) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
    if (fullPage) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.cdp.send("Page.captureScreenshot", params, { timeout: 30_000 });
    await writeFile(filePath, Buffer.from(data, "base64"));
    return filePath;
  }

  async getCookies() {
    const { cookies } = await this.cdp.send("Network.getCookies");
    return cookies;
  }

  async setCookie({ name, value, url, httpOnly = true, sameSite = "Lax", secure = false }) {
    const { success } = await this.cdp.send("Network.setCookie", {
      name,
      value,
      url,
      httpOnly,
      sameSite,
      secure,
      path: "/",
    });
    if (!success) throw new Error("cookie rejected: " + name);
  }

  async clearCookies() {
    await this.cdp.send("Network.clearBrowserCookies");
  }

  async waitForLocation(pattern, { timeout = 20_000 } = {}) {
    const isRegExp = pattern instanceof RegExp;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const href = await this.eval("location.href");
      const matches = isRegExp ? pattern.test(href) : href.includes(pattern);
      if (matches) return href;
      await sleep(120);
    }
    const finalHref = await this.eval("location.href");
    throw new Error("location never matched " + String(pattern) + "; still " + finalHref);
  }
}

export function ms(value) {
  return Number.isFinite(value) ? Math.round(value) + "ms" : "n/a";
}
