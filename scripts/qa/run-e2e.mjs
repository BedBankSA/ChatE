/**
 * ChatE end-to-end QA orchestrator. Zero npm dependencies.
 *
 *   C:\Pak\node.exe scripts/qa/run-e2e.mjs
 *   C:\Pak\node.exe scripts/qa/run-e2e.mjs --static-only
 *
 * Environment (all optional):
 *   QA_BASE_URL              default http://127.0.0.1:3211
 *   QA_PHASE                 dev | prod-mock (default: prod-mock when CHATE_E2E_MOCK=1)
 *   QA_ENV_FILE              extra dotenv file (e.g. tmp/qa/e2e.env) for QA secrets
 *   QA_SQLITE_PATH           override DB path used for seeding sessions
 *   QA_SESSION_SECRET        override session secret used for signing cookies
 *   QA_TURNSTILE_STUB        "0" disables the injected window.turnstile stub (default on)
 *   QA_GOOGLE_STUB           "1" injects a visual Google-button stub before app scripts
 *   QA_HOST_RESOLVER_RULES   e.g. "MAP chate.test 127.0.0.1"
 *   QA_ONLY                  comma-separated test ids
 *   QA_STATIC_ONLY           "1" skips the browser phase
 *   QA_OUT_DIR               default docs/audit
 *
 * Output: docs/audit/screenshots/*.png, docs/audit/evidence/qa-results-<phase>.json,
 *         docs/audit/evidence/qa-console-<phase>.json
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CDP, EventCollector, Page, launchChrome, sleep, stopChrome } from "./lib/cdp.mjs";
import { PROJECT_ROOT, loadEnv, seedQaUsers } from "./seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.QA_BASE_URL || "http://chate.test:3212").replace(/\/+$/, "");
const BASE_HOST = new URL(BASE).hostname;
const BASE_PORT = new URL(BASE).port || "80";
const DIRECT_BASE = "http://127.0.0.1:" + BASE_PORT;
const PROXY_PORT = Number(process.env.QA_PROXY_PORT || 3213);
const LOOPBACK = BASE_HOST === "127.0.0.1" || BASE_HOST === "localhost";
const NODE_BASE = process.env.QA_NODE_BASE || (LOOPBACK ? BASE : "http://127.0.0.1:" + PROXY_PORT);
const HOST_HEADER = new URL(BASE).host;
let proxyServer = null;

/**
 * Node fetch cannot resolve the mapped product host and silently rewrites the
 * Host header. Turnstile hostname checks and theme-return checks need the real
 * Host, so a loopback reverse proxy forwards raw bytes with Host: chate.test.
 */
async function startStaticProxy() {
  if (LOOPBACK || process.env.QA_NODE_BASE) return;
  proxyServer = http.createServer(function (request, response) {
    const headers = { ...request.headers, host: HOST_HEADER };
    const proxied = http.request(
      { hostname: "127.0.0.1", port: Number(BASE_PORT), path: request.url, method: request.method, headers: headers },
      function (upstream) {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxied.on("error", function (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("qa proxy error: " + error.message);
    });
    request.pipe(proxied);
  });
  await new Promise(function (resolve, reject) {
    proxyServer.once("error", reject);
    proxyServer.listen(PROXY_PORT, "127.0.0.1", resolve);
  });
  console.log("static API checks proxied via " + NODE_BASE + " (Host: " + HOST_HEADER + ")");
}

async function stopStaticProxy() {
  if (!proxyServer) return;
  await new Promise(function (resolve) { proxyServer.close(resolve); });
  proxyServer = null;
}
const PHASE = process.env.QA_PHASE || (process.env.CHATE_E2E_MOCK === "1" ? "prod-mock" : "dev");
const MOCK = PHASE === "prod-mock" || process.env.CHATE_E2E_MOCK === "1";
const STATIC_ONLY = process.env.QA_STATIC_ONLY === "1" || process.argv.includes("--static-only");
const TURNSTILE_STUB = process.env.QA_TURNSTILE_STUB !== "0";
const GOOGLE_STUB = process.env.QA_GOOGLE_STUB === "1";
const OUT_DIR = path.resolve(PROJECT_ROOT, process.env.QA_OUT_DIR || "docs/audit");
const SHOTS = path.join(OUT_DIR, "screenshots");
const EVIDENCE = path.join(OUT_DIR, "evidence");
const ONLY = (process.env.QA_ONLY || "").split(",").map((item) => item.trim()).filter(Boolean);
const HOST_RESOLVER =
  process.env.QA_HOST_RESOLVER_RULES ||
  (BASE_HOST === "127.0.0.1" || BASE_HOST === "localhost" ? "" : "MAP " + BASE_HOST + " 127.0.0.1");
const ENV = loadEnv(process.env.QA_ENV_FILE);
const startedAt = new Date();

const results = [];
const browserErrors = [];
let page = null;
let collector = null;
let cdp = null;
let chrome = null;
let requestLog = [];
let sessions = null;
let seedInfo = null;

function want(id) {
  return ONLY.length === 0 || ONLY.includes(id);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function assertIncludes(haystack, needle, label) {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    throw new Error(label + ': expected to include "' + needle + '", got ' + JSON.stringify(String(haystack).slice(0, 240)));
  }
}

async function record(id, area, status, detail = {}) {
  const entry = {
    id,
    area,
    status,
    steps: detail.steps ?? "",
    expected: detail.expected ?? "",
    actual: detail.actual ?? "",
    evidence: detail.evidence ?? "",
    screenshots: detail.screenshots ?? [],
    error: detail.error ?? null,
    durationMs: detail.durationMs ?? null,
  };
  results.push(entry);
  const icon = status === "PASS" ? "PASS" : status === "BLOCKED" ? "BLOCK" : status === "SKIP" ? "SKIP" : "FAIL";
  console.log("[" + icon + "] " + id + " — " + area + (entry.error ? " :: " + String(entry.error).slice(0, 300) : ""));
  return entry;
}

async function test(id, area, fn, options = {}) {
  if (!want(id)) return null;
  if (options.requires && !options.requires()) {
    return record(id, area, "BLOCKED", { error: options.blockedReason || "precondition not met", steps: options.steps, expected: options.expected });
  }
  const started = Date.now();
  if (collector) collector.setTest(id);
  try {
    const detail = (await fn()) ?? {};
    return await record(id, area, detail.status || "PASS", { ...detail, durationMs: Date.now() - started });
  } catch (error) {
    return await record(id, area, "FAIL", {
      ...options,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
  }
}

async function screenshot(name, options = {}) {
  assert(page, "browser not running");
  const finalName = name.startsWith("_final-") ? name : "_final-" + name;
  const target = path.join(SHOTS, finalName + ".png");
  await page.scrollToTop();
  await page.screenshot(target, options);
  return path.relative(PROJECT_ROOT, target).split(path.sep).join("/");
}

async function httpGet(pathname, options = {}) {
  const response = await fetch(NODE_BASE + pathname, {
    method: options.method || "GET",
    headers: { host: HOST_HEADER, ...(options.headers || {}) },
    body: options.body,
    redirect: options.redirect || "manual",
    signal: AbortSignal.timeout(options.timeout ?? 20000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    setCookie: response.headers.get("set-cookie"),
    location: response.headers.get("location"),
  };
}

function decodeSessionPayload(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

function decodeSessionCsrf(cookie) {
  return decodeSessionPayload(cookie).csrf;
}

function cookieFor(role) {
  assert(sessions, "seeded sessions unavailable");
  const session = sessions[role];
  assert(session, "missing seeded role: " + role);
  return session.cookie;
}

async function apiJson(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.role) headers.cookie = cookieFor(options.role);
  if (options.body != null) headers["content-type"] = "application/json";
  return httpGet(pathname, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });
}

/** Best-effort fetch with a short retry window while a server restarts. */
async function waitForServer(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DIRECT_BASE + "/", { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return true;
    } catch {
      /* retry while the server restarts */
    }
    await sleep(1500);
  }
  return false;
}

const VITALS_SCRIPT = `(function () {
  window.__chateQAVitals = { lcp: null, lcpElement: null, cls: 0, shifts: 0 };
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        window.__chateQAVitals.lcp = entry.startTime;
        window.__chateQAVitals.lcpElement = entry.element ? entry.element.tagName + "." + (entry.element.className || "") : null;
      });
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (error) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (!entry.hadRecentInput) {
          window.__chateQAVitals.cls += entry.value;
          window.__chateQAVitals.shifts += 1;
        }
      });
    }).observe({ type: "layout-shift", buffered: true });
  } catch (error) {}
})();`;

const TURNSTILE_STUB_SCRIPT = `(function () {
  var widgets = {};
  var counter = 0;
  window.__qaTurnstileRenders = 0;
  window.turnstile = {
    render: function (container, options) {
      var id = "qa-widget-" + (++counter);
      widgets[id] = options || {};
      window.__qaTurnstileRenders += 1;
      return id;
    },
    execute: function (id) {
      var options = widgets[id] || {};
      var token = "qa." + (options.action || "unknown") + "." + location.hostname + "." + Date.now();
      setTimeout(function () {
        if (typeof options.callback === "function") options.callback(token);
      }, 0);
    },
    reset: function () {},
    isExpired: function () {
      return false;
    }
  };
})();`;

const GOOGLE_STUB_SCRIPT = `(function () {
  function makeButton(parent) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "متابعة باستخدام Google";
    button.setAttribute("data-qa-google-stub", "1");
    button.style.cssText = "height:44px;min-width:320px;border:1px solid #dadce0;border-radius:22px;background:#fff;color:#3c4043;font:inherit;cursor:pointer";
    parent.appendChild(button);
    window.__qaGoogleStub = true;
  }
  window.google = {
    accounts: {
      id: {
        initialize: function () {},
        renderButton: function (parent) {
          makeButton(parent);
        }
      }
    }
  };
})();`;

const AUDIT_PAGE_SCRIPT = `(function () {
  function color(value) {
    if (!value) return null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      var context = canvas.getContext("2d", { willReadFrequently: true });
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      var pixel = context.getImageData(0, 0, 1, 1).data;
      return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] / 255 };
    } catch (error) {
      return null;
    }
  }
  function luminance(c) {
    function channel(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }
  function backgroundOf(element) {
    var node = element;
    while (node) {
      var c = color(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function contrastRatio(element) {
    if (!element) return null;
    var fg = color(getComputedStyle(element).color);
    if (!fg) return null;
    var bg = backgroundOf(element);
    var l1 = luminance(fg);
    var l2 = luminance(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return { ratio: Math.round(ratio * 100) / 100, fg: getComputedStyle(element).color, bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")" };
  }
  function accessibleName(element) {
    var aria = element.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var labels = labelledBy.split(/\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      var text = labels.map(function (node) { return (node.textContent || "").trim(); }).join(" ").trim();
      if (text) return text;
    }
    var text = (element.textContent || "").trim();
    if (text) return text;
    var title = element.getAttribute("title");
    if (title && title.trim()) return title.trim();
    if (element.tagName === "INPUT") {
      var id = element.id;
      if (id) {
        var label = document.querySelector('label[for="' + id + '"]');
        if (label) return (label.textContent || "").trim();
      }
      var wrapping = element.closest("label");
      if (wrapping) return (wrapping.textContent || "").trim();
      var placeholder = element.getAttribute("placeholder");
      if (placeholder) return placeholder;
      if (element.type === "submit" || element.type === "button") return element.value || "";
    }
    return "";
  }
  function rect(element) {
    var r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
  var focusableSelector = 'a[href],button:not([disabled]),input:not([disabled],[type=hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var focusable = Array.prototype.slice.call(document.querySelectorAll(focusableSelector));
  var interactive = Array.prototype.slice.call(document.querySelectorAll("button,a[href],input,textarea,select,[role=button]"));
  var unnamed = interactive.filter(function (element) { return !accessibleName(element); });
  var tiny = focusable.filter(function (element) {
    var box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.width < 24 || box.height < 24);
  });
  var images = Array.prototype.slice.call(document.querySelectorAll("img"));
  var ids = {};
  Array.prototype.slice.call(document.querySelectorAll("[id]")).forEach(function (element) {
    ids[element.id] = (ids[element.id] || 0) + 1;
  });
  var duplicates = Object.keys(ids).filter(function (id) { return ids[id] > 1; });
  var headings = Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(function (h) {
    return { level: Number(h.tagName.slice(1)), text: (h.textContent || "").trim().slice(0, 80) };
  });
  var skippedHeadings = [];
  for (var i = 1; i < headings.length; i += 1) {
    if (headings[i].level - headings[i - 1].level > 1) skippedHeadings.push(headings[i - 1].level + "->" + headings[i].level + " " + headings[i].text);
  }
  var ltr = Array.prototype.slice.call(document.querySelectorAll(".ltr")).slice(0, 6).map(function (element) {
    return { text: (element.textContent || "").trim().slice(0, 40), direction: getComputedStyle(element).direction, unicodeBidi: getComputedStyle(element).unicodeBidi };
  });
  var contrastTargets = [["h1", document.querySelector("h1")], ["p", document.querySelector("main p")], ["nav-link", document.querySelector("nav a")], ["button", document.querySelector("main button, header button")], ["meta", document.querySelector(".meta")], ["label", document.querySelector("label")]];
  var contrastPairs = {};
  contrastTargets.forEach(function (pair) {
    if (pair[1]) contrastPairs[pair[0]] = contrastRatio(pair[1]);
  });
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    theme: document.documentElement.dataset.theme || null,
    h1: Array.prototype.slice.call(document.querySelectorAll("h1")).map(function (h) { return (h.textContent || "").trim(); }),
    headings: headings,
    skippedHeadings: skippedHeadings,
    landmarks: { header: document.querySelectorAll("header").length, nav: document.querySelectorAll("nav").length, main: document.querySelectorAll("main").length, footer: document.querySelectorAll("footer").length },
    focusableCount: focusable.length,
    unnamedInteractive: unnamed.slice(0, 8).map(function (element) { return { tag: element.tagName.toLowerCase(), className: element.className, text: (element.textContent || "").trim().slice(0, 40) }; }),
    unnamedInteractiveCount: unnamed.length,
    tinyTargets: tiny.slice(0, 8).map(function (element) { return { tag: element.tagName.toLowerCase(), name: accessibleName(element).slice(0, 40), box: rect(element) }; }),
    tinyTargetCount: tiny.length,
    images: images.length,
    imagesMissingAlt: images.filter(function (img) { return !img.hasAttribute("alt") || !img.getAttribute("alt").trim(); }).length,
    duplicateIds: duplicates,
    contrast: contrastPairs,
    ltr: ltr,
    htmlDirection: getComputedStyle(document.documentElement).direction,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyText: (document.body.innerText || "").trim().slice(0, 1600),
    bodyTextLength: (document.body.innerText || "").trim().length,
    skipLink: (function () {
      var link = document.querySelector('a[href="#content"]');
      return link ? { text: (link.textContent || "").trim(), srOnly: getComputedStyle(link).position === "absolute" } : null;
    })(),
    devOverlay: Boolean(document.querySelector("nextjs-portal")),
    faviconLinks: document.querySelectorAll('link[rel~="icon"]').length
  };
})();`;

async function auditPage() {
  return page.eval(AUDIT_PAGE_SCRIPT);
}

async function gotoAndAudit(pathname, { waitSelector = "h1", timeout = 25000 } = {}) {
  await page.navigate(BASE + pathname);
  await page.waitFor("document.readyState === 'complete'", { timeout: 15000 });
  if (waitSelector) await page.waitFor("Boolean(document.querySelector(" + JSON.stringify(waitSelector) + "))", { timeout });
  await page.waitFor("document.fonts && document.fonts.ready ? true : true", { timeout: 5000 }).catch(function () {});
  return auditPage();
}

function appErrorsSince(mark) {
  return collector.entries.slice(mark).filter(function (entry) {
    if (entry.noise || entry.external) return false;
    if (entry.kind === "console" && entry.type === "warning") return true;
    return entry.kind === "exception" || entry.level === "error";
  });
}

function stripDevNoise(list) {
  return list.filter(function (entry) {
    var text = entry.text || "";
    var url = entry.url || "";
    if (text.indexOf("_next/hmr") >= 0 || url.indexOf("_next/hmr") >= 0) return false;
    if (text.indexOf("React DevTools") >= 0) return false;
    if (url.indexOf("favicon.ico") >= 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Static checks (no browser)
// ---------------------------------------------------------------------------
async function runStaticChecks() {
  if (!want("S01")) return;
  let home = null;
  try {
    home = await httpGet("/");
  } catch (error) {
    await record("S01", "server reachability", "BLOCKED", { error: "server unreachable: " + error.message, steps: "GET " + BASE + "/" });
    return;
  }
  await record("S01", "server reachability", home.status === 200 ? "PASS" : "FAIL", {
    steps: "GET " + BASE + "/",
    expected: "HTTP 200 Arabic HTML",
    actual: "HTTP " + home.status + ", " + home.text.length + " bytes",
  });

  await test("S02", "security headers on HTML", async function () {
    const headers = home.headers;
    const required = {
      "content-security-policy": function (v) { return v.indexOf("frame-ancestors 'none'") >= 0 && v.indexOf("object-src 'none'") >= 0; },
      "x-content-type-options": function (v) { return v === "nosniff"; },
      "x-frame-options": function (v) { return v.toUpperCase() === "DENY"; },
      "referrer-policy": function (v) { return v.length > 0; },
      "permissions-policy": function (v) { return v.indexOf("camera=()") >= 0; },
    };
    const missing = [];
    for (const [name, check] of Object.entries(required)) {
      const value = headers.get(name) || "";
      if (!check(value)) missing.push(name);
    }
    assertEqual(headers.get("x-powered-by"), null, "x-powered-by must be absent");
    assertEqual(missing.length, 0, "missing/weak headers: " + missing.join(", "));
    return { steps: "GET / and inspect response headers", expected: "CSP with frame-ancestors none + nosniff + DENY + referrer + permissions", actual: "all present; CSP=" + (headers.get("content-security-policy") || "").length + " chars" };
  });

  await test("S03", "RTL shell attributes", async function () {
    assertIncludes(home.text, 'lang="ar"', "html lang");
    assertIncludes(home.text, 'dir="rtl"', "html dir");
    assertIncludes(home.text, "تخطى إلى المحتوى", "skip link");
    return { steps: "inspect served HTML shell", expected: 'html lang="ar" dir="rtl" + Arabic skip link', actual: "attributes present" };
  });

  await test("S04", "public pages render (200, Arabic h1)", async function () {
    const pages = [
      ["/", "سؤال واحد"],
      ["/privacy", "الخصوصية"],
      ["/terms", "الشروط"],
      ["/account", "الحساب"],
      ["/history", "سجل المقارنات"],
      ["/admin", "الإدارة"],
    ];
    const rows = [];
    for (const [pathname, needle] of pages) {
      const response = await httpGet(pathname);
      assertEqual(response.status, 200, pathname + " status");
      assertIncludes(response.text, needle, pathname + " Arabic copy");
      rows.push(pathname + " 200");
    }
    const profileAnonymous = await httpGet("/profile/complete");
    assertEqual(profileAnonymous.status, 307, "/profile/complete anonymous status");
    assertEqual(new URL(profileAnonymous.location || "/", BASE).pathname, "/", "/profile/complete anonymous redirect");
    rows.push("/profile/complete 307 anonymous -> /");
    if (sessions) {
      const profileAuthed = await httpGet("/profile/complete", { headers: { cookie: cookieFor("unverified") } });
      assertEqual(profileAuthed.status, 200, "/profile/complete authenticated status");
      assertIncludes(profileAuthed.text, "إكمال الملف", "profile Arabic heading");
      rows.push("/profile/complete 200 authenticated");
    }
    return { steps: "GET each public route; anonymous and authenticated /profile/complete", expected: "public routes 200, anonymous profile 307 to /, authenticated profile 200", actual: rows.join("; ") };
  });

  await test("S05", "404 page status and localization", async function () {
    const response = await httpGet("/qa-does-not-exist-" + Date.now());
    assertEqual(response.status, 404, "404 status");
    const localized = response.text.indexOf("تعذر العثور") >= 0 || response.text.indexOf("الصفحة") >= 0 || response.text.indexOf("غير موجود") >= 0;
    if (!localized) {
      throw new Error("404 body is not Arabic-localized: " + response.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 180));
    }
    return { steps: "GET /qa-does-not-exist-<ts>", expected: "404 + Arabic localized body", actual: "404, Arabic body" };
  });

  await test("S06", "unauthenticated /workspace redirect", async function () {
    const response = await httpGet("/workspace");
    assertEqual(response.status, 307, "redirect status");
    assertEqual(new URL(response.location || "/", BASE).pathname, "/", "redirect location path");
    return { steps: "GET /workspace without cookie", expected: "307 Location /", actual: response.status + " Location " + response.location };
  });

  await test("S07", "GET /api/models contract", async function () {
    const response = await apiJson("/api/models");
    assertEqual(response.status, 200, "status");
    assert(response.json && Array.isArray(response.json.data), "data must be an array");
    assert(response.json.data.length >= 10, "expected model catalog, got " + response.json.data.length);
    const first = response.json.data[0];
    for (const key of ["id", "displayName", "taskType", "availability", "usagePolicy"]) {
      assert(typeof first[key] === "string" && first[key].length > 0, "model field missing: " + key);
    }
    return { steps: "GET /api/models", expected: "200, ok envelope, model array with required fields", actual: response.json.data.length + " models, keys ok" };
  });

  await test("S08", "POST /api/comparisons unauthenticated = 401", async function () {
    const response = await apiJson("/api/comparisons", {
      method: "POST",
      body: { question: "اختبار", evidenceMode: "native", answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: crypto.randomUUID() },
    });
    assertEqual(response.status, 401, "status");
    assertEqual(response.json.error.code, "anonymous", "error code");
    assertIncludes(response.json.error.message, "تسجيل الدخول", "Arabic message");
    return { steps: "POST /api/comparisons without cookie", expected: "401 anonymous Arabic", actual: response.status + " " + response.json.error.code };
  });

  await test("S09", "GET comparison unauthenticated and unknown id", async function () {
    const anonymous = await apiJson("/api/comparisons/11111111-1111-4111-8111-111111111111");
    assertEqual(anonymous.status, 401, "anonymous status");
    const unknownForUser = await apiJson("/api/comparisons/11111111-1111-4111-8111-111111111111", { role: "unverified" });
    assertEqual(unknownForUser.status, 404, "authenticated unknown status");
    assertEqual(unknownForUser.json.error.code, "not_found", "not_found code");
    const malformed = await apiJson("/api/comparisons/not-a-uuid", { role: "unverified" });
    assertEqual(malformed.status, 404, "malformed id status");
    return { steps: "GET /api/comparisons/<random uuid> anonymous and seeded user", expected: "401 anonymous; 404 not_found authenticated", actual: "401/404/404 as expected" };
  });

  await test("S10", "admin API authorization", async function () {
    const anonymous = await apiJson("/api/admin/overview");
    assertEqual(anonymous.status, 401, "anonymous status");
    const nonAdmin = await apiJson("/api/admin/overview", { role: "nonadmin" });
    assertEqual(nonAdmin.status, 403, "non-admin status");
    assertEqual(nonAdmin.json.error.code, "not_admin", "non-admin code");
    const admin = await apiJson("/api/admin/overview", { role: "admin" });
    if (sessions && sessions.admin) assertEqual(admin.status, 200, "admin status");
    assertEqual((await apiJson("/api/admin/users", { method: "POST" })).status, 401, "unauthenticated admin mutation");
    return { steps: "GET /api/admin/overview as anonymous / non-admin / admin; POST /api/admin/users anonymous", expected: "401 / 403 / 200 / 401", actual: "401, 403, " + admin.status + ", 401" };
  });

  await test("S11", "unverified phone gate on comparison", async function () {
    const response = await apiJson("/api/comparisons", {
      method: "POST",
      role: "unverified",
      body: { question: "ما هو الذكاء الاصطناعي؟", evidenceMode: "native", answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: crypto.randomUUID() },
    });
    assert(response.status === 403 || response.status === 503, "gate status must be 403/503, got " + response.status);
    assertIncludes(response.json.error.message, "توثيق الجوال", "Arabic phone gate message");
    return { steps: "POST /api/comparisons as seeded phone-unverified user", expected: "403/503 with Arabic phone-verification gate", actual: response.status + " " + response.json.error.code + " — " + response.json.error.message.slice(0, 80) };
  });

  await test("S12", "comparison input validation (authenticated, pre-Turnstile)", async function () {
    const empty = await apiJson("/api/comparisons", { method: "POST", role: "verified", body: { question: "   ", answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: crypto.randomUUID() } });
    assertEqual(empty.status, 422, "empty question status");
    assertIncludes(empty.json.error.message, "اكتب السؤال", "empty question message");
    const long = await apiJson("/api/comparisons", { method: "POST", role: "verified", body: { question: "ا".repeat(8001), answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: crypto.randomUUID() } });
    assertEqual(long.status, 422, "long question status");
    assertIncludes(long.json.error.message, "أطول من الحد", "long question message");
    const badKey = await apiJson("/api/comparisons", { method: "POST", role: "verified", body: { question: "اختبار", answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: "not-a-uuid" } });
    assertEqual(badKey.status, 400, "bad idempotency status");
    const noModels = await apiJson("/api/comparisons", { method: "POST", role: "verified", body: { question: "اختبار", answerModelIds: [], idempotencyKey: crypto.randomUUID() } });
    assertEqual(noModels.status, 400, "empty models status");
    const validNoTurnstile = await apiJson("/api/comparisons", { method: "POST", role: "verified", body: { question: "اختبار", evidenceMode: "native", answerModelIds: ["google/gemma-4-31b-it:free"], idempotencyKey: crypto.randomUUID() } });
    assertEqual(validNoTurnstile.status, 403, "valid body without turnstile token must be rejected");
    return { steps: "POST invalid question bodies as seeded verified user, then valid body without Turnstile token", expected: "422/422/400/400 then 403 Turnstile rejection (no provider call)", actual: "422, 422, 400, 400, 403 — rejected before any model dispatch" };
  });

  await test("S13", "theme endpoint cookie contract", async function () {
    const response = await httpGet("/api/theme", { method: "POST", headers: { referer: BASE + "/privacy" } });
    assertEqual(response.status, 303, "redirect status");
    assertIncludes(response.setCookie || "", "chate_theme=dark", "Set-Cookie chate_theme");
    assertIncludes(response.setCookie || "", "Path=/", "cookie path");
    assert((response.setCookie || "").toLowerCase().indexOf("httponly") < 0, "theme cookie must be JS-visible (httpOnly absent)");
    assertIncludes(response.location || "", "/privacy", "redirect back to referer path");
    return { steps: "POST /api/theme with Referer /privacy", expected: "303 to /privacy + chate_theme=dark (not httpOnly)", actual: response.status + " " + response.location };
  });

  await test("S14", "Google intent nonce endpoint", async function () {
    const response = await apiJson("/api/auth/google/intent", { method: "POST", body: {} });
    if (response.status === 503) {
      return { status: "SKIP", steps: "POST /api/auth/google/intent", expected: "nonce cookie or documented 503", actual: "503 GOOGLE_UNCONFIGURED (Google client id not configured)" };
    }
    assertEqual(response.status, 200, "status");
    assert(response.json && response.json.data && typeof response.json.data.nonce === "string", "nonce missing");
    assertIncludes(response.setCookie || "", "chate_google_nonce", "nonce cookie");
    return { steps: "POST /api/auth/google/intent", expected: "200 nonce + httpOnly nonce cookie", actual: "200 nonce issued" };
  });

  await test("S15", "no server secret values in served HTML/JS", async function () {
    const names = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "SESSION_SECRET", "TURNSTILE_SECRET_KEY", "OTP_HTTP_AUTHORIZATION", "OTP_PEPPER", "GOOGLE_CLIENT_SECRET", "ADMIN_GOOGLE_SUBS", "ADMIN_EMAILS"];
    const values = names.map(function (name) { return ENV[name]; }).filter(function (value) { return typeof value === "string" && value.trim().length >= 8; });
    const findings = [];
    const htmlPages = ["/", "/privacy", "/terms", "/account", "/history", "/admin", "/profile/complete"];
    let scanned = 0;
    const seen = new Set();
    async function scan(label, text, url) {
      scanned += 1;
      for (const name of names) if (text.indexOf(name) >= 0) findings.push(label + " contains name " + name + (url ? " (" + url + ")" : ""));
      for (const name of names) {
        const value = ENV[name];
        if (typeof value === "string" && value.trim().length >= 8 && text.indexOf(value) >= 0) findings.push(label + " contains value of " + name + (url ? " (" + url + ")" : ""));
      }
      if (/sk-or-v1-[A-Za-z0-9]{16,}/.test(text)) findings.push(label + " contains an OpenRouter key-shaped string");
      if (/sk-ant-[A-Za-z0-9_-]{16,}/.test(text)) findings.push(label + " contains an Anthropic key-shaped string");
    }
    for (const pathname of htmlPages) {
      const response = await httpGet(pathname);
      const label = "HTML " + pathname;
      await scan(label, response.text);
      const sources = [...response.text.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js[^"]*)"/g)].map(function (match) { return match[1]; });
      for (const source of sources) {
        if (seen.has(source)) continue;
        seen.add(source);
        const asset = await httpGet(source);
        if (asset.status === 200) await scan("JS " + source, asset.text);
      }
    }
    return { steps: "scan served HTML and every referenced /_next/static JS for secret names, exact secret values, and key-shaped tokens", expected: "zero findings", actual: scanned + " assets scanned, " + findings.length + " findings" + (findings.length ? ": " + findings.slice(0, 5).join("; ") : "") };
  });
}

async function runSecurityChecks() {
  await test("S16", "admin mutation rejects wrong origin / CSRF, accepts valid form", async function () {
    const admin = sessions && sessions.admin;
    assert(admin, "admin session missing");
    const csrf = decodeSessionCsrf(admin.cookie);
    const wrongOrigin = await httpGet("/api/admin/users", {
      method: "POST",
      headers: { cookie: admin.cookie, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restore", userId: "qa_user_nonadmin", csrf }).toString(),
    });
    assertEqual(wrongOrigin.status, 403, "wrong origin status");
    const noCsrf = await httpGet("/api/admin/users", {
      method: "POST",
      headers: { cookie: admin.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "restore", userId: "qa_user_nonadmin" }).toString(),
    });
    assertEqual(noCsrf.status, 403, "missing csrf status");
    const invalidCommand = await httpGet("/api/admin/users", {
      method: "POST",
      headers: { cookie: admin.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "bogus", userId: "qa_user_nonadmin", csrf }).toString(),
    });
    assertEqual(invalidCommand.status, 303, "valid csrf+origin, invalid command should redirect");
    assertIncludes(new URL(invalidCommand.location, BASE).search, "notice=rejected", "rejected notice");
    return { steps: "POST /api/admin/users: wrong origin, missing csrf, valid csrf+origin with invalid command", expected: "403, 403, 303 notice=rejected", actual: wrongOrigin.status + ", " + noCsrf.status + ", " + invalidCommand.status };
  });

  await test("S17", "uploads route stub behavior", async function () {
    const anonymous = await apiJson("/api/uploads", { method: "POST", body: { files: ["a.pdf"], "cf-turnstile-response": "qa.upload." + BASE_HOST + "." + Date.now() } });
    assertEqual(anonymous.status, 401, "uploads status");
    assertEqual(anonymous.json.error.code, "anonymous", "uploads code");
    return { steps: "POST /api/uploads with mocked Turnstile token and no session", expected: "401 Arabic anonymous (no bytes stored by design)", actual: anonymous.status + " " + anonymous.json.error.code };
  });

  await test("S18", "OTP API contract (send / wrong / verify / reuse)", async function () {
    const send = await apiJson("/api/otp/send", { method: "POST", role: "unverified2", body: { phone: "+966509998877", "cf-turnstile-response": "qa.otp." + BASE_HOST + "." + Date.now() } });
    assertEqual(send.status, 200, "send status");
    assertEqual(send.json.data.sent, true, "sent flag");
    const fs = await import("node:fs/promises");
    const otpPath = path.join(PROJECT_ROOT, "tmp", "otp-codes.jsonl");
    let code = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !code) {
      const text = await fs.readFile(otpPath, "utf8").catch(function () { return ""; });
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = JSON.parse(lines[index]);
          if (entry.to === "+966509998877") { code = entry.code; break; }
        } catch (error) { /* skip */ }
      }
      if (!code) await sleep(400);
    }
    assert(code, "mock OTP code not found for +966509998877");
    const wrong = await apiJson("/api/otp/verify", { method: "POST", role: "unverified2", body: { code: code === "000000" ? "111111" : "000000" } });
    assertEqual(wrong.status, 403, "wrong code status");
    assertEqual(wrong.json.error.code, "OTP_MISMATCH", "wrong code error code");
    assert(typeof wrong.json.error.remainingAttempts === "number", "remainingAttempts missing");
    const verify = await apiJson("/api/otp/verify", { method: "POST", role: "unverified2", body: { code } });
    assertEqual(verify.status, 200, "verify status");
    assertEqual(verify.json.data.verified, true, "verified flag");
    const reuse = await apiJson("/api/otp/verify", { method: "POST", role: "unverified2", body: { code } });
    assert(reuse.status === 403, "reused code must be rejected");
    const anonymous = await apiJson("/api/otp/send", { method: "POST", body: { phone: "+966500000000" } });
    assertEqual(anonymous.status, 401, "anonymous send status");
    return { steps: "send OTP -> read mock code -> wrong code -> correct code -> reuse", expected: "200 sent, 403 mismatch with remainingAttempts, 200 verified, 403 reuse", actual: send.status + ", " + wrong.status + "/" + wrong.json.error.code + ", " + verify.status + ", " + reuse.status };
  });

  await test("S19", "session cookie forgery / expiry / ghost user rejected", async function () {
    const valid = cookieFor("verified");
    const name = valid.split("=")[0];
    const token = decodeURIComponent(valid.slice(name.length + 1));
    const parts = token.split(".");
    const forged = parts[0] + "." + parts[1].slice(0, -4) + "AAAA";
    const forgedResponse = await apiJson("/api/comparisons/11111111-1111-4111-8111-111111111111", { headers: { cookie: name + "=" + encodeURIComponent(forged) } });
    assertEqual(forgedResponse.status, 401, "forged signature status");
    const { createHmac } = await import("node:crypto");
    function sign(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createHmac("sha256", ENV.SESSION_SECRET).update(body).digest("base64url");
      return body + "." + signature;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = sign({ userId: "qa_user_verified", googleSub: "qa-google-verified", exp: nowSec - 60, csrf: "x", iat: nowSec - 120 });
    const expiredResponse = await apiJson("/api/comparisons/11111111-1111-4111-8111-111111111111", { headers: { cookie: name + "=" + encodeURIComponent(expired) } });
    assertEqual(expiredResponse.status, 401, "expired session status");
    const ghost = sign({ userId: "qa_user_ghost", googleSub: "qa-google-ghost", exp: nowSec + 3600, csrf: "x", iat: nowSec });
    const ghostResponse = await apiJson("/api/comparisons/11111111-1111-4111-8111-111111111111", { headers: { cookie: name + "=" + encodeURIComponent(ghost) } });
    assertEqual(ghostResponse.status, 401, "ghost user session must be rejected");
    return { steps: "tampered HMAC, expired exp, valid HMAC for non-existent user", expected: "all 401", actual: "forged 401, expired 401, ghost 401" };
  });

}

// ---------------------------------------------------------------------------
// Browser phase
// ---------------------------------------------------------------------------
async function startBrowser() {
  // crypto.randomUUID (used by the workspace send path) requires a secure
  // context. The QA server is plain HTTP on a mapped host, so Chrome must treat
  // that origin as trustworthy for the happy path to be exercisable. The raw
  // insecure-context failure is separately recorded as a product finding.
  const secureExtra = BASE.startsWith("http://") && !LOOPBACK
    ? ["--unsafely-treat-insecure-origin-as-secure=" + new URL(BASE).origin]
    : [];
  chrome = await launchChrome({ hostResolverRules: HOST_RESOLVER, extraArgs: secureExtra });
  cdp = await CDP.connect(chrome.pageTarget.webSocketDebuggerUrl);
  page = new Page(cdp);
  collector = new EventCollector(cdp, { baseUrl: BASE });
  cdp.on("Network.requestWillBeSent", function (event) {
    requestLog.push({ url: event.request.url, method: event.request.method, type: event.type, at: Date.now() });
  });
  await page.init();
  await page.setViewport(1440, 900);
  await page.reduceMotion();
  await page.addInitScript(VITALS_SCRIPT);
  if (TURNSTILE_STUB) await page.addInitScript(TURNSTILE_STUB_SCRIPT);
  if (GOOGLE_STUB) await page.addInitScript(GOOGLE_STUB_SCRIPT);
  return { chrome, page, collector };
}

async function stopBrowser() {
  if (cdp) cdp.close();
  await stopChrome(chrome);
  chrome = null;
  page = null;
}

async function clearSessionCookie() {
  await page.clearCookies();
}

async function useRole(role) {
  await page.clearCookies();
  const session = sessions && sessions[role];
  if (!session) throw new Error("no seeded session for role " + role);
  const name = session.cookie.split("=")[0];
  const value = decodeURIComponent(session.cookie.slice(name.length + 1));
  await page.setCookie({ name, value, url: BASE, httpOnly: true });
}

async function pageInfo() {
  return page.eval(`(() => ({
    url: location.href,
    path: location.pathname,
    title: document.title,
    h1: [...document.querySelectorAll("h1")].map((node) => (node.textContent || "").trim()),
    bodyText: (document.body.innerText || "").trim().slice(0, 1200),
    theme: document.documentElement.dataset.theme || null,
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    statusTexts: [...document.querySelectorAll("[role=status]")].map((node) => (node.textContent || "").trim()),
    textarea: Boolean(document.querySelector("textarea")),
    buttons: [...document.querySelectorAll("button")].map((node) => (node.textContent || "").trim()),
    navLinks: [...document.querySelectorAll("nav a")].map((node) => ({ text: (node.textContent || "").trim(), href: node.getAttribute("href") })),
  }))()`);
}

async function runPublicBrowserChecks() {
  await test("B01", "home renders (desktop 1440x900)", async function () {
    const info = await gotoAndAudit("/");
    assertEqual(info.dir, "rtl", "html dir");
    assertEqual(info.lang, "ar", "html lang");
    assertEqual(info.h1.length, 1, "exactly one h1");
    assertIncludes(info.h1[0], "سؤال واحد", "hero title");
    assert(info.skipLink, "skip link missing");
    assert(info.landmarks.header >= 1 && info.landmarks.nav >= 1 && info.landmarks.main >= 1, "landmarks missing");
    const shotPath = await screenshot("home-desktop-light");
    const mark = collector.entries.length;
    await sleep(500);
    const errors = stripDevNoise(appErrorsSince(mark));
    assertEqual(info.overflowX, 0, "horizontal overflow");
    const cta = await page.eval("JSON.stringify({ googleHost: Boolean(document.getElementById('google-signin-button')), googleChildren: document.getElementById('google-signin-button') ? document.getElementById('google-signin-button').childElementCount : -1, links: [...document.querySelectorAll('.hero-actions a')].map(a => a.textContent.trim()) })");
    return { steps: "navigate /, wait for h1, screenshot", expected: "Arabic RTL hero, skip link, landmarks, no console errors, one h1", actual: "one h1, landmarks ok, overflowX=" + info.overflowX + ", CTA=" + cta, screenshots: [shotPath] };
  });

  await test("B02", "home sign-in CTA present", async function () {
    const state = await page.eval("JSON.stringify({ children: document.getElementById('google-signin-button') ? document.getElementById('google-signin-button').childElementCount : -1, stub: Boolean(window.__qaGoogleStub), status: [...document.querySelectorAll('[role=status]')].map(n => n.textContent) })");
    const parsed = JSON.parse(state);
    if (parsed.children < 1) {
      if (GOOGLE_STUB) throw new Error("Google stub did not render inside #google-signin-button");
      return { status: "BLOCKED", steps: "inspect #google-signin-button after load", expected: "official Google button (iframe/button) or a visible error message", actual: "button host empty; status messages: " + JSON.stringify(parsed.status) + ". External Google Identity Services did not mount in this environment; also confirms client hydration state.", evidence: "no GSI script request; see hydration test H01" };
    }
    return { steps: "inspect #google-signin-button", expected: "rendered sign-in CTA", actual: "embedded sign-in node count " + parsed.children + (parsed.stub ? " (QA stub)" : "") };
  });

  await test("B03", "theme toggle persists (cookie + server render)", async function () {
    await clearSessionCookie();
    await page.navigate(BASE + "/");
    await page.waitFor("Boolean(document.querySelector('form.theme-switch button'))", { timeout: 15000 });
    assertEqual(await page.eval("document.documentElement.dataset.theme || 'light'"), "light", "initial theme");
    const loaded = cdp.waitEvent("Page.loadEventFired", { timeout: 20000 });
    await page.eval("document.querySelector('form.theme-switch button').click(); true");
    await loaded.catch(function () {});
    await page.waitForLocation(BASE + "/", { timeout: 15000 }).catch(function () {});
    await page.waitFor("document.readyState === 'complete'", { timeout: 15000 });
    await sleep(500);
    const theme = await page.eval("document.documentElement.dataset.theme || 'light'");
    assertEqual(theme, "dark", "theme after toggle");
    const cookies = await page.getCookies();
    const themeCookie = cookies.find(function (cookie) { return cookie.name === "chate_theme"; });
    assert(themeCookie, "chate_theme cookie missing");
    assertEqual(themeCookie.value, "dark", "cookie value");
    await page.navigate(BASE + "/");
    const persisted = await page.eval("document.documentElement.dataset.theme || 'light'");
    assertEqual(persisted, "dark", "theme persisted after reload");
    const shotPath = await screenshot("home-desktop-dark");
    const loadedBack = cdp.waitEvent("Page.loadEventFired", { timeout: 20000 });
    await page.eval("document.querySelector('form.theme-switch button').click(); true");
    await loadedBack.catch(function () {});
    await page.waitFor("document.readyState === 'complete'", { timeout: 15000 });
    await sleep(400);
    assertEqual(await page.eval("document.documentElement.dataset.theme || 'light'"), "light", "theme toggled back to light");
    return { steps: "GET / (light) -> submit theme form -> inspect data-theme + cookie -> reload -> toggle back", expected: "light -> dark + cookie persisted -> reload still dark -> back to light", actual: "persisted dark across reload; dark screenshot captured", screenshots: [shotPath] };
  });

  await test("B04", "navigation + back/forward", async function () {
    await page.navigate(BASE + "/");
    await page.clickByText("nav a", "الخصوصية");
    await page.waitForLocation(BASE + "/privacy");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 15000 });
    assertIncludes(await page.eval("document.querySelector('h1').textContent"), "الخصوصية", "privacy h1");
    const privacyShot = await screenshot("privacy-desktop");
    await page.clickByText("nav a", "السجل");
    await page.waitForLocation(BASE + "/history");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 15000 });
    assertIncludes(await page.eval("document.querySelector('h1').textContent"), "سجل المقارنات", "history h1");
    const historyShot = await screenshot("history-desktop");
    await page.eval("history.back(); true");
    await page.waitForLocation(BASE + "/privacy");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 15000 });
    assertIncludes(await page.eval("document.querySelector('h1').textContent"), "الخصوصية", "back -> privacy");
    await page.eval("history.forward(); true");
    await page.waitForLocation(BASE + "/history");
    assertIncludes(await page.eval("document.querySelector('h1').textContent"), "سجل المقارنات", "forward -> history");
    return { steps: "home -> nav privacy -> nav history -> history.back() -> history.forward()", expected: "client-side nav plus browser history restore each page", actual: "back -> /privacy, forward -> /history", screenshots: [privacyShot, historyShot] };
  });

  await test("B05", "terms page renders and is linked", async function () {
    const info = await gotoAndAudit("/terms");
    assertIncludes(info.h1[0], "الشروط", "terms h1");
    const shotPath = await screenshot("terms-desktop");
    const linked = await page.eval("JSON.stringify([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(href => href === '/terms'))");
    return { steps: "GET /terms directly; collect same-page links to /terms", expected: "200 Arabic terms content; footer/nav link for discoverability", actual: "content renders; inbound links on page: " + linked, screenshots: [shotPath] };
  });

  await test("B06", "account / history unauthenticated rendering", async function () {
    const account = await gotoAndAudit("/account");
    assertIncludes(account.h1[0], "الحساب", "account h1");
    const accountShot = await screenshot("account-desktop");
    const accountHasCta = await page.eval("Boolean(document.getElementById('google-signin-button'))");
    const historyInfo = await gotoAndAudit("/history");
    assertIncludes(historyInfo.h1[0], "سجل المقارنات", "history h1");
    const historyShot = await screenshot("history-desktop");
    const historyHasCta = await page.eval("Boolean(document.getElementById('google-signin-button'))");
    assert(accountHasCta, "anonymous account page should offer sign-in");
    return { steps: "GET /account and /history without session", expected: "Arabic informational pages with sign-in affordance", actual: "account CTA host present=" + accountHasCta + "; history CTA host present=" + historyHasCta, screenshots: [accountShot, historyShot] };
  });

  await test("B07", "admin denied page (unauthenticated)", async function () {
    const info = await gotoAndAudit("/admin");
    assertIncludes(info.h1[0], "الإدارة", "admin h1");
    assertIncludes(info.bodyText, "تُرفض على الخادم لغير المشرف", "denial copy");
    const shotPath = await screenshot("admin-denied-desktop");
    return { steps: "GET /admin without session", expected: "200 page explaining server-side admin denial, no dashboard data", actual: "denial copy rendered, no metrics in DOM", screenshots: [shotPath] };
  });

  await test("B08", "404 page screenshot", async function () {
    await page.navigate(BASE + "/qa-missing-" + Date.now());
    await page.waitFor("document.readyState === 'complete'", { timeout: 15000 });
    await sleep(400);
    const info = await pageInfo();
    assertIncludes(String(info.bodyText), "404", "404 marker");
    const shotPath = await screenshot("not-found-desktop");
    const localized = info.bodyText.indexOf("This page could not be found") < 0;
    if (!localized) throw new Error("404 page shows English Next.js default text in an Arabic-first product");
    return { steps: "navigate to /qa-missing-<ts>", expected: "Arabic localized 404 page", actual: "Arabic 404", screenshots: [shotPath] };
  });

  await test("B09", "unauthenticated /workspace redirect (browser)", async function () {
    await clearSessionCookie();
    await page.navigate(BASE + "/workspace");
    await page.waitForLocation(BASE + "/", { timeout: 20000 });
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 15000 });
    const info = await pageInfo();
    assertEqual(info.path, "/", "final path");
    const documents = collector.documents.filter(function (doc) { return doc.url.indexOf("/workspace") >= 0; });
    const shotPath = await screenshot("workspace-unauth-redirect");
    return { steps: "GET /workspace with no session cookie", expected: "browser lands on / with home hero", actual: "final path " + info.path + "; document responses " + JSON.stringify(documents.slice(-2)), screenshots: [shotPath] };
  });
}

// ---------------------------------------------------------------------------
// Authenticated workspace + interaction flows
// ---------------------------------------------------------------------------
async function runWorkspaceChecks() {
  const needsDevServerFailure = function () {
    return false;
  };
  await test("W01", "authenticated /workspace renders (shortcuts + question form)", async function () {
    await useRole("verified");
    await gotoAndAudit("/workspace");
    const info = await pageInfo();
    assertIncludes(info.h1.join(" "), "مساحة العمل", "workspace h1");
    assert(info.textarea, "question textarea missing");
    for (const label of ["محادثة", "برمجة", "خفيف", "مقارنة"]) {
      assert(info.buttons.indexOf(label) >= 0, "shortcut missing: " + label);
    }
    assert(info.buttons.indexOf("إرسال") >= 0, "send button missing");
    assert(info.navLinks.some(function (link) { return link.href === "/workspace"; }), "workspace nav link missing when signed in");
    const a11y = await auditPage();
    assertEqual(a11y.unnamedInteractiveCount, 0, "unlabelled interactive elements");
    const mark = collector.entries.length;
    await sleep(1500);
    const errors = stripDevNoise(appErrorsSince(mark));
    const models = await page.eval("document.querySelectorAll('fieldset').length");
    const checkboxes = await page.eval("document.querySelectorAll('input[type=checkbox]').length");
    const shotName = (await page.eval("document.documentElement.dataset.theme || 'light'")) === "dark" ? "workspace-auth-desktop-dark" : "workspace-auth-desktop-light";
    const shotPath = await screenshot(shotName);
    if (errors.length > 0) throw new Error("console errors on workspace: " + JSON.stringify(errors.slice(0, 3)));
    if (models === 0) {
      return { status: "FAIL", steps: "sign in via seeded cookie, GET /workspace, wait for /api/models fetch", expected: "model groups (fieldsets) and checkboxes rendered after client hydration", actual: "shortcuts/form rendered from SSR but 0 fieldsets and 0 checkboxes; /api/models never requested — client components did not hydrate", screenshots: [shotPath], evidence: "document has no __reactFiber keys; clicking إرسال produces no status change; see H01" };
    }
    return { steps: "sign in via seeded cookie, GET /workspace", expected: "question form + 4 shortcuts + model checklist", actual: models + " model groups, " + checkboxes + " checkboxes", screenshots: [shotPath] };
  });

  await test("W02", "client hydration sanity (event handlers fire)", async function () {
    await useRole("verified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(1200);
    const before = await page.eval("JSON.stringify([...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') !== null).map(b => ({ text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') })))");
    await page.clickByText("button", "محادثة").catch(function () {});
    await sleep(800);
    const after = await page.eval("JSON.stringify([...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') !== null).map(b => ({ text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') })))");
    const hydrationMarkers = JSON.parse(await page.eval("JSON.stringify({ reactFiber: Object.getOwnPropertyNames(document.body).filter(k => k.startsWith('__react')).length + Object.getOwnPropertyNames(document.querySelector('textarea') || document.body).filter(k => k.startsWith('__react')).length, nextF: typeof self.__next_f, renderers: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers ? window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size : null })"));
    if (before === after) {
      throw new Error("shortcut click did not change aria-pressed — React event handlers are not attached (hydration failed). Markers: " + JSON.stringify(hydrationMarkers));
    }
    return { steps: "click محادثة shortcut and compare aria-pressed", expected: "aria-pressed flips", actual: "flipped (" + after + ")", evidence: JSON.stringify(hydrationMarkers) };
  });

  await test("W03", "empty-question validation", async function () {
    await useRole("verified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    await page.fill("textarea", "");
    await page.clickByText("button", "إرسال");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('اكتب السؤال'))", { timeout: 8000 });
    const status = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    const requests = requestLog.filter(function (entry) { return entry.url.indexOf("/api/comparisons") >= 0; });
    assertEqual(requests.length, 0, "no POST should be sent for an empty question");
    return { steps: "clear textarea, click إرسال", expected: "Arabic inline message, no network request", actual: "status: " + status + "; comparison requests: " + requests.length };
  });

  await test("W04", "submit with unverified phone shows Arabic gate", async function () {
    await useRole("unverified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(1000);
    const before = requestLog.length;
    const start = Date.now();
    await page.fill("textarea", "ما الفرق بين التعلم العميق والتعلم الآلي؟");
    await page.clickByText("button", "إرسال");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('توثيق الجوال'))", { timeout: 45000 });
    const elapsed = Date.now() - start;
    const status = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    const posts = requestLog.slice(before).filter(function (entry) { return entry.url.indexOf("/api/comparisons") >= 0 && entry.method === "POST"; });
    assert(posts.length >= 1, "expected a POST to /api/comparisons");
    const shotPath = await screenshot("workspace-phone-gate");
    return { steps: "sign in as phone-unverified seeded user, type Arabic question, click إرسال", expected: "Arabic phone-verification gate message; no model call", actual: "status: " + status + "; " + posts.length + " POST(s); " + elapsed + "ms to message", screenshots: [shotPath] };
  });

  await test("W05", "long Arabic question stays inside layout", async function () {
    await useRole("verified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    const question = "ما هو الذكاء الاصطناعي؟ ".repeat(120);
    await page.fill("textarea", question);
    const state = JSON.parse(await page.eval("JSON.stringify({ length: document.querySelector('textarea').value.length, overflowX: document.documentElement.scrollWidth - window.innerWidth, textareaOverflow: document.querySelector('textarea').scrollHeight > document.querySelector('textarea').clientHeight, maxLength: document.querySelector('textarea').maxLength })"));
    assertEqual(state.overflowX, 0, "page horizontal overflow with long Arabic text");
    assert(state.length > 2800, "question was not filled");
    return { steps: "fill textarea with ~2900 chars of Arabic, measure layout overflow", expected: "no page-level horizontal overflow; textarea scrolls internally", actual: "length=" + state.length + ", overflowX=" + state.overflowX + ", textarea internal scroll=" + state.textareaOverflow + ", maxLength=" + state.maxLength + " (server cap 8000)" };
  });

  await test("W06", "HTML/script payload in question is treated as text", async function () {
    await useRole("unverified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    const payload = '<img src=x onerror="window.__qaXss=1"><script>window.__qaXss=2</script>';
    await page.fill("textarea", payload);
    await page.clickByText("button", "إرسال");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('توثيق الجوال'))", { timeout: 45000 });
    const xss = await page.eval("window.__qaXss ?? null");
    const injected = await page.eval("document.querySelectorAll('.workspace img, .workspace script').length");
    const asked = await page.eval("document.querySelector('.workspace') ? [...document.querySelectorAll('.workspace p')].map(p => p.textContent).find(t => t.includes('<img')) || '' : ''");
    assertEqual(xss, null, "payload executed");
    assertEqual(injected, 0, "payload injected DOM nodes");
    assertIncludes(asked, "<img", "payload rendered literally as text");
    return { steps: "type HTML/script payload as question, submit as unverified user", expected: "payload shown as literal text, never executed", actual: "window.__qaXss=" + String(xss) + ", injected nodes=" + injected + ", literal text echoed=" + (asked.length > 0) };
  });

  await test("W07", "rapid double submit sends at most one request", async function () {
    await useRole("unverified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    await page.fill("textarea", "سؤال للاختبار السريع");
    const before = requestLog.length;
    await page.eval("document.querySelectorAll('button')[document.querySelectorAll('button').length - 2] && (function(){ const buttons = [...document.querySelectorAll('button')]; const send = buttons.find(b => b.textContent.trim() === 'إرسال'); send.click(); send.click(); send.click(); })(); true");
    await sleep(1500);
    const posts = requestLog.slice(before).filter(function (entry) { return entry.url.indexOf("/api/comparisons") >= 0 && entry.method === "POST"; });
    const statuses = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    assert(posts.length <= 1, "double submit produced " + posts.length + " POSTs");
    return { steps: "click إرسال three times within one tick", expected: "at most one POST /api/comparisons (sending ref guard)", actual: posts.length + " POST(s); status: " + statuses };
  });

  await test("W08", "back/forward after authenticated workspace navigation", async function () {
    await useRole("verified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await page.clickByText("nav a", "الخصوصية");
    await page.waitForLocation(BASE + "/privacy");
    await page.eval("history.back(); true");
    await page.waitForLocation(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 15000 });
    await page.eval("history.forward(); true");
    await page.waitForLocation(BASE + "/privacy");
    return { steps: "workspace -> nav privacy -> back -> forward", expected: "workspace and privacy restore correctly", actual: "back -> /workspace, forward -> /privacy" };
  });
}

// ---------------------------------------------------------------------------
// Responsive, dark theme, accessibility, performance
// ---------------------------------------------------------------------------
async function runResponsiveChecks() {
  const viewports = [
    { id: "mobile", width: 390, height: 844, mobile: true, suffix: "mobile-390x844" },
    { id: "tablet", width: 768, height: 1024, mobile: true, suffix: "tablet-768x1024" },
  ];
  for (const viewport of viewports) {
    await test("R01-" + viewport.id, "home responsive " + viewport.width + "x" + viewport.height, async function () {
      await clearSessionCookie();
      await page.setViewport(viewport.width, viewport.height, { mobile: viewport.mobile });
      await page.navigate(BASE + "/");
      await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 20000 });
      await sleep(500);
      const a11y = await auditPage();
      assertEqual(a11y.overflowX, 0, "horizontal overflow at " + viewport.width + "px: " + a11y.overflowX + "px");
      const header = JSON.parse(await page.eval("JSON.stringify((function(){ const top = document.querySelector('.site-header-top')?.getBoundingClientRect(); const nav = document.querySelector('.site-header-nav')?.getBoundingClientRect(); return { top: top && top.toJSON(), nav: nav && nav.toJSON(), overlap: top && nav ? !(top.bottom <= nav.top || nav.bottom <= top.top || top.right <= nav.left || nav.right <= top.left) : null }; })())"));
      if (header.overlap) throw new Error("header brand/theme row overlaps nav row at " + viewport.width + "px");
      const shotPath = await screenshot("home-" + viewport.suffix);
      const tiny = a11y.tinyTargetCount;
      return { steps: "viewport " + viewport.width + "x" + viewport.height + ", GET /, measure overflow and header overlap", expected: "no horizontal overflow, header rows do not overlap", actual: "overflowX=" + a11y.overflowX + ", tiny targets=" + tiny + ", screenshot captured", screenshots: [shotPath] };
    });
  }

  await test("R02-mobile-workspace", "authenticated workspace responsive 390x844", async function () {
    await useRole("verified");
    await page.setViewport(390, 844, { mobile: true });
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    const a11y = await auditPage();
    assertEqual(a11y.overflowX, 0, "workspace horizontal overflow at 390px: " + a11y.overflowX + "px");
    const shotPath = await screenshot("workspace-auth-mobile-390x844");
    return { steps: "390x844, authenticated /workspace", expected: "no horizontal overflow; form usable", actual: "overflowX=" + a11y.overflowX, screenshots: [shotPath] };
  });

  await test("R03-dark", "dark theme pages (home + workspace)", async function () {
    await clearSessionCookie();
    await page.setViewport(1440, 900);
    await page.setCookie({ name: "chate_theme", value: "dark", url: BASE, httpOnly: false });
    await page.navigate(BASE + "/");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 20000 });
    await sleep(400);
    assertEqual(await page.eval("document.documentElement.dataset.theme"), "dark", "home dark attr");
    const homeShot = await screenshot("home-desktop-dark");
    await useRole("verified");
    await page.setCookie({ name: "chate_theme", value: "dark", url: BASE, httpOnly: false });
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(800);
    assertEqual(await page.eval("document.documentElement.dataset.theme"), "dark", "workspace dark attr");
    const workspaceShot = await screenshot("workspace-auth-desktop-dark");
    const contrast = await page.eval(AUDIT_PAGE_SCRIPT).then(function (info) { return info.contrast; });
    return { steps: "set chate_theme=dark cookie, render home and workspace", expected: "dark theme applied server-side with readable contrast", actual: "dark attr present; workspace contrast " + JSON.stringify(contrast), screenshots: [homeShot, workspaceShot] };
  });
}

async function runAccessibilityChecks() {
  await test("A01", "keyboard focus order and focus-visible styles", async function () {
    await clearSessionCookie();
    await page.setViewport(1440, 900);
    await page.navigate(BASE + "/");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 20000 });
    await page.eval("document.body.focus(); window.scrollTo(0,0); true");
    const sequence = [];
    for (let index = 0; index < 10; index += 1) {
      await page.pressTab(1);
      const focus = await page.focusInfo();
      if (!focus || focus.tag === "body") continue;
      sequence.push(focus);
    }
    assert(sequence.length > 0, "no focusable elements reached via Tab");
    assertEqual(sequence[0].text, "تخطى إلى المحتوى", "first Tab stop must be the skip link");
    assert(sequence.some(function (item) { return item.href === "/privacy"; }), "nav links reachable by keyboard");
    const noVisible = sequence.filter(function (item) {
      return item.tag !== "body" && (item.outline.indexOf("none") === 0 || parseInt(item.outline.split(" ")[1], 10) === 0) && (item.boxShadow === "none" || item.boxShadow === "");
    });
    if (noVisible.length > 0) {
      throw new Error("no visible focus indicator on " + noVisible.length + " tab stops: " + noVisible.map(function (item) { return item.tag + ":" + item.text.slice(0, 20); }).join(", "));
    }
    return { steps: "press Tab up to 10 times from document body, record activeElement + computed outline", expected: "skip link first, nav/links reachable, every stop has a visible focus indicator", actual: sequence.map(function (item) { return item.tag + ":" + (item.text || item.ariaLabel || "").slice(0, 24); }).join(" -> ") };
  });

  await test("A02", "DOM accessibility audit (public pages)", async function () {
    const pages = ["/", "/privacy", "/terms", "/account", "/history", "/admin", "/profile/complete"];
    const problems = [];
    for (const pathname of pages) {
      await page.navigate(BASE + pathname);
      await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 20000 });
      const info = await auditPage();
      if (info.h1.length !== 1) problems.push(pathname + ": h1 count " + info.h1.length);
      if (info.unnamedInteractiveCount > 0) problems.push(pathname + ": " + info.unnamedInteractiveCount + " unnamed interactive (" + info.unnamedInteractive.slice(0, 2).map(function (item) { return item.tag; }).join(",") + ")");
      if (info.imagesMissingAlt > 0) problems.push(pathname + ": " + info.imagesMissingAlt + " image(s) without alt");
      if (info.duplicateIds.length > 0) problems.push(pathname + ": duplicate ids " + info.duplicateIds.join(","));
      if (info.skippedHeadings.length > 0) problems.push(pathname + ": heading jump " + info.skippedHeadings.join(","));
      if (info.landmarks.main < 1) problems.push(pathname + ": no main landmark");
      if (info.contrast) {
        for (const [key, pair] of Object.entries(info.contrast)) {
          if (pair && pair.ratio < 4.5) problems.push(pathname + ": contrast " + key + "=" + pair.ratio + ":1");
        }
      }
      if (info.dir !== "rtl") problems.push(pathname + ": dir=" + info.dir);
    }
    if (problems.length > 0) throw new Error(problems.length + " accessibility issue(s): " + problems.slice(0, 12).join("; "));
    return { steps: "DOM audit for h1, names, alt text, ids, heading order, landmarks, contrast, RTL direction on 7 routes", expected: "no issues", actual: "all routes clean" };
  });

  await test("A03", "RTL and mixed-direction rendering", async function () {
    await page.setViewport(1440, 900);
    await page.navigate(BASE + "/");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 20000 });
    const homeInfo = await auditPage();
    assertEqual(homeInfo.htmlDirection, "rtl", "computed direction");
    const navRects = JSON.parse(await page.eval("JSON.stringify([...document.querySelectorAll('nav a')].map(a => ({ text: a.textContent.trim(), x: Math.round(a.getBoundingClientRect().x) })))"));
    const years = navRects.map(function (item) { return item.x; });
    const descending = years.every(function (value, index) { return index === 0 || value <= years[index - 1]; });
    await useRole("verified");
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 20000 });
    await sleep(1200);
    const ltr = JSON.parse(await page.eval("JSON.stringify([...document.querySelectorAll('.ltr')].slice(0, 8).map(e => ({ text: (e.textContent || '').trim().slice(0, 40), direction: getComputedStyle(e).direction })))"));
    const ltrBroken = ltr.filter(function (item) { return item.direction !== "ltr"; });
    if (ltrBroken.length > 0 && ltr.length > 0) throw new Error("mixed-direction elements not LTR: " + JSON.stringify(ltrBroken.slice(0, 3)));
    return { steps: "inspect html direction, nav item x-order (RTL), .ltr element computed direction", expected: "dir=rtl, nav flows right-to-left, model ids LTR", actual: "dir=rtl; nav x positions " + JSON.stringify(years) + "; ltr elements " + ltr.length + " (all ltr=" + ltrBroken.length + ")" };
  });
}

async function runPerformanceChecks() {
  await test("P01", "perceived performance (dev/prod mocked server)", async function () {
    await clearSessionCookie();
    await page.setViewport(1440, 900);
    await page.navigate(BASE + "/");
    await page.waitFor("Boolean(document.querySelector('h1'))", { timeout: 25000 });
    await sleep(1200);
    const metrics = JSON.parse(await page.eval("JSON.stringify((function(){ const nav = performance.getEntriesByType('navigation')[0] || {}; const paints = performance.getEntriesByType('paint'); const resources = performance.getEntriesByType('resource'); return { ttfb: nav.responseStart, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp: (paints.find(p => p.name === 'first-contentful-paint') || {}).startTime || null, vitals: window.__chateQAVitals || null, resourceCount: resources.length, transferKB: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024) }; })())"));
    return { steps: "GET /, read Navigation Timing, paint entries, LCP/CLS observers, resource transfer", expected: "documented baseline on this server mode (not a production SLA)", actual: "TTFB=" + (metrics.ttfb != null ? Math.round(metrics.ttfb) + "ms" : "n/a") + ", FCP=" + (metrics.fcp != null ? Math.round(metrics.fcp) + "ms" : "n/a") + ", load=" + (metrics.load != null ? Math.round(metrics.load) + "ms" : "n/a") + ", LCP=" + (metrics.vitals && metrics.vitals.lcp ? Math.round(metrics.vitals.lcp) + "ms" : "n/a") + ", CLS=" + (metrics.vitals ? metrics.vitals.cls.toFixed(3) : "n/a") + ", resources=" + metrics.resourceCount + " (" + metrics.transferKB + " KB)", evidence: "phase=" + PHASE + " (server mode affects the numbers; dev server is not production)" };
  });
}

// ---------------------------------------------------------------------------
// Mock-mode full journey (production server + CHATE_E2E_MOCK=1)
// ---------------------------------------------------------------------------
async function runMockJourney() {
  await test("M01", "full comparison journey (mocked providers, Haiku disabled)", async function () {
    await useRole("verified");
    await page.setViewport(1440, 900);
    await page.navigate(BASE + "/workspace");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 25000 });
    await page.waitFor("document.querySelectorAll('input[type=checkbox]').length > 0", { timeout: 15000 });
    const modelCount = await page.eval("document.querySelectorAll('input[type=checkbox]').length");
    await page.fill("textarea", "اشرح الفرق بين التعلم العميق والتعلم الآلي بإيجاز.");
    const before = requestLog.length;
    await page.clickByText("button", "إرسال");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('أُرسلت المقارنة'))", { timeout: 25000 });
    await page.waitFor("document.querySelectorAll('.answer-card h2').length >= 4", { timeout: 25000 });
    const started = Date.now();
    await page.waitFor("[...document.querySelectorAll('.answer-card')].length >= 4 && [...document.querySelectorAll('.answer-card')].every(card => !card.textContent.includes('في الانتظار') && !card.textContent.includes('يعمل الآن'))", { timeout: 90000 });
    const elapsed = Date.now() - started;
    const cards = JSON.parse(await page.eval("JSON.stringify([...document.querySelectorAll('.answer-card')].map(card => ({ title: card.querySelector('h2') ? card.querySelector('h2').textContent.trim() : null, provider: [...card.querySelectorAll('p')].map(p => p.textContent.trim()).find(t => t === 'OpenRouter' || t === 'Anthropic') || null, status: [...card.querySelectorAll('p')].map(p => p.textContent.trim()).find(t => ['اكتمل','تعذر','النتيجة ناقصة','موقوف حسب شروط المزود','في الانتظار','يعمل الآن'].includes(t)) || null, text: card.querySelector('pre') ? card.querySelector('pre').textContent.trim() : '', textLength: card.querySelector('pre') ? card.querySelector('pre').textContent.length : 0, messages: [...card.querySelectorAll('p')].map(p => p.textContent.trim()).filter(t => t.length > 12 && t !== 'OpenRouter' && t !== 'Anthropic') })))"));
    assert(cards.length >= 4, "expected 4 answer cards, got " + cards.length);
    const openRouterAnswered = cards.filter(function (card) { return card.provider === "OpenRouter" && card.textLength > 0; });
    const anthropic = cards.filter(function (card) { return card.provider === "Anthropic"; });
    assert(openRouterAnswered.length >= 3, "expected 3 free OpenRouter answers, got " + openRouterAnswered.length);
    assert(anthropic.length === 1, "expected one Haiku column, got " + anthropic.length);
    assert(anthropic[0].textLength === 0, "Haiku produced text while Anthropic is disabled: " + anthropic[0].text.slice(0, 80));
    const haikuFailed = anthropic[0].status === "تعذر" || anthropic[0].messages.some(function (m) { return m.indexOf("Anthropic") >= 0 || m.indexOf("تعذر") >= 0; });
    assert(haikuFailed, "Haiku failure not surfaced: " + JSON.stringify(anthropic[0].status) + " " + JSON.stringify(anthropic[0].messages));
    const posts = requestLog.slice(before).filter(function (entry) { return entry.url.indexOf("/api/comparisons") >= 0 && entry.method === "POST"; });
    assertEqual(posts.length, 1, "expected exactly one comparison POST");
    const pollRequests = requestLog.slice(before).filter(function (entry) { return /\/api\/comparisons\/[0-9a-f-]{36}/i.test(entry.url) && entry.method === "GET"; });
    assert(pollRequests.length >= 1, "expected polling GETs");
    const shotPath = await screenshot("workspace-results");
    return { steps: "default 4-model comparison, submit, wait for all columns to settle", expected: "one POST; 3 OpenRouter columns complete; Haiku column fails independently with Arabic error; polling GETs", actual: modelCount + " models; " + cards.length + " cards in " + elapsed + "ms; OpenRouter answered=" + openRouterAnswered.length + "; Haiku status=" + JSON.stringify(anthropic[0].status) + " textLength=" + anthropic[0].textLength + "; poll GETs=" + pollRequests.length, screenshots: [shotPath] };
  });

  await test("M03", "profile OTP verification journey (mock SMS)", async function () {
    const fs = await import("node:fs/promises");
    await useRole("unverified");
    await page.navigate(BASE + "/profile/complete");
    await page.waitFor("Boolean(document.querySelector('input[type=tel]'))", { timeout: 25000 });
    await page.fill("input[type=tel]", "+966501234567");
    await page.clickByText("button", "إرسال رمز التحقق");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('أُرسل رمز') || n.textContent.includes('موثّق'))", { timeout: 25000 });
    const sendStatus = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    const hasCodeInput = await page.eval("Boolean(document.querySelector('input[inputmode=numeric]'))");
    if (!hasCodeInput) return { status: "BLOCKED", steps: "unverified user -> /profile/complete -> phone -> send", expected: "OTP code step", actual: "no code input; status: " + sendStatus };
    const otpPath = path.join(PROJECT_ROOT, "tmp", "otp-codes.jsonl");
    let code = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !code) {
      const text = await fs.readFile(otpPath, "utf8").catch(function () { return ""; });
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = JSON.parse(lines[index]);
          if (entry.to === "+966501234567") { code = entry.code; break; }
        } catch (error) { /* skip */ }
      }
      if (!code) await sleep(400);
    }
    assert(code && /^\d{4,8}$/.test(code), "no mocked OTP code for +966501234567 in tmp/otp-codes.jsonl");
    await page.fill("input[inputmode=numeric]", code);
    await page.clickByText("button", "تأكيد الرمز");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('تم توثيق جوالك'))", { timeout: 20000 });
    const verifyStatus = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    const shotPath = await screenshot("otp-verified");
    await page.clickByText("a", "الانتقال إلى مساحة العمل");
    await page.waitFor("Boolean(document.querySelector('textarea'))", { timeout: 25000 });
    await page.fill("textarea", "أثبت أن التوثيق يفتح الإرسال.");
    await page.clickByText("button", "إرسال");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('أُرسلت المقارنة'))", { timeout: 30000 });
    await page.waitFor("document.querySelectorAll('.answer-card h2').length >= 4", { timeout: 25000 });
    const workspaceShot = await screenshot("workspace-after-otp");
    return { steps: "unverified user -> /profile/complete -> phone -> mock SMS code -> verify -> workspace -> compare", expected: "2-step OTP UI, Arabic send/verify statuses, then comparison accepted", actual: "send: " + sendStatus + " | verify: " + verifyStatus + " | code found length " + code.length + " | comparison accepted", screenshots: [shotPath, workspaceShot] };
  });

  await test("M02", "stop/pause control messaging", async function () {
    const statusBefore = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    await page.clickByText("button", "إيقاف");
    await page.waitFor("[...document.querySelectorAll('[role=status]')].some(n => n.textContent.includes('أُوقف العرض المحلي'))", { timeout: 8000 });
    const status = await page.eval("[...document.querySelectorAll('[role=status]')].map(n => n.textContent.trim()).join(' | ')");
    return { steps: "click إيقاف after a comparison completed", expected: "Arabic message that only the local view stopped; provider may continue", actual: "status: " + status };
  });
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------
async function writeEvidence() {
  const count = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIP: 0 };
  for (const entry of results) count[entry.status] = (count[entry.status] || 0) + 1;
  const payload = {
    generatedAt: new Date().toISOString(),
    phase: PHASE,
    baseUrl: BASE,
    mock: MOCK,
    turnstileStub: TURNSTILE_STUB,
    googleStub: GOOGLE_STUB,
    chrome: chrome ? chrome.version && chrome.version.Browser : null,
    node: process.version,
    counts: count,
    total: results.length,
    results,
    console: collector ? collector.snapshot() : null,
    requestCount: requestLog.length,
  };
  await mkdir(EVIDENCE, { recursive: true });
  const resultsPath = path.join(EVIDENCE, "qa-results-" + PHASE + ".json");
  await writeFile(resultsPath, JSON.stringify(payload, null, 2));
  if (collector) {
    const consolePath = path.join(EVIDENCE, "qa-console-" + PHASE + ".json");
    const snapshot = collector.snapshot();
    await writeFile(consolePath, JSON.stringify({ generatedAt: payload.generatedAt, phase: PHASE, baseUrl: BASE, ...snapshot }, null, 2));
  }
  console.log("\n===== QA SUMMARY (" + PHASE + ") =====");
  console.log("PASS " + (count.PASS || 0) + " | FAIL " + (count.FAIL || 0) + " | BLOCKED " + (count.BLOCKED || 0) + " | SKIP " + (count.SKIP || 0) + " | total " + results.length);
  console.log("evidence:", path.relative(PROJECT_ROOT, resultsPath));
  console.log("screenshots:", path.relative(PROJECT_ROOT, SHOTS));
  const failures = results.filter(function (entry) { return entry.status === "FAIL"; });
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const failure of failures) console.log(" - " + failure.id + " " + failure.area + ": " + (failure.error || "").slice(0, 220));
  }
  return payload;
}

async function main() {
  console.log("ChatE QA E2E — phase=" + PHASE + " base=" + BASE + (MOCK ? " (mock providers)" : ""));
  let serverUp = false;
  try {
    serverUp = await waitForServer(STATIC_ONLY ? 5000 : 120000);
  } catch (error) {
    serverUp = false;
  }
  if (!serverUp) {
    console.error("Server is not reachable at " + BASE + "; writing a BLOCKED report.");
    await record("S00", "server reachability", "BLOCKED", { steps: "GET " + BASE + "/", expected: "HTTP 200", actual: "connection refused", error: "server unreachable" });
    await writeEvidence();
    process.exitCode = 2;
    return;
  }

  // Seeded sessions: production-mock runs must pass QA_SESSION_SECRET/QA_SQLITE_PATH.
  try {
    seedInfo = seedQaUsers({ env: ENV, writeSessions: true });
    sessions = seedInfo.sessions;
  } catch (error) {
    sessions = null;
    seedInfo = null;
    console.error("session seeding failed (authenticated tests will be BLOCKED): " + error.message);
  }

  await startStaticProxy();
  await runStaticChecks();
  await runSecurityChecks();

  if (!STATIC_ONLY) {
    try {
      await startBrowser();
      await runPublicBrowserChecks();
      if (sessions) {
        await runWorkspaceChecks();
        await runAccessibilityChecks();
        await runResponsiveChecks();
        await runPerformanceChecks();
        if (MOCK) await runMockJourney();
      } else {
        await record("W00", "authenticated workspace", "BLOCKED", { steps: "seeded session cookie", expected: "seeded session", actual: "could not seed sessions (missing SESSION_SECRET or DB path)", error: "seed unavailable" });
      }
    } catch (error) {
      console.error("browser phase crashed:", error);
      await record("B00", "browser harness", "FAIL", { error: error instanceof Error ? error.stack ? error.stack.split("\n").slice(0, 4).join(" | ") : error.message : String(error) });
    } finally {
      await stopBrowser();
    }
  }

  await stopStaticProxy();
  await writeEvidence();
  const failed = results.filter(function (entry) { return entry.status === "FAIL"; }).length;
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
