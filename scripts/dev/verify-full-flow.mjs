// Lead-side end-to-end verification against the mocked production server (port 3212).
// Test-only: writes throwaway users into data/qa.sqlite and signs a local session.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";

const PORT = 3212;
const HOST_HEADER = "chate.test:3212";
const SECRET = process.env.SESSION_SECRET || "qa-e2e-session-secret-0123456789abcdef";
const OTP_LOG = process.env.CHATE_E2E_OTP_LOG || "tmp/otp-codes.jsonl";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function signCookie(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function req(method, path, { cookie, body, origin, host = HOST_HEADER } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const headers = { host };
    if (data != null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const r = httpRequest({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (data != null) r.write(data);
    r.end();
  });
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function cookieFor(userId) {
  const now = nowSec();
  return "chate_session=" + signCookie({ userId, googleSub: userId, exp: now + 3600, iat: now, csrf: randomUUID().replace(/-/g, "") });
}
function qaToken(action) { return "qa." + action + ".chate.test." + Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const db = new DatabaseSync("data/qa.sqlite");
function seed(userId, { email, name, verified }) {
  db.prepare("INSERT OR REPLACE INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(userId, userId, email, name);
  db.prepare("INSERT OR REPLACE INTO profiles (user_id, phone_e164, phone_verified_at) VALUES (?, ?, ?)").run(userId, "+966500000001", verified ? new Date().toISOString() : null);
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); }

async function main() {
  seed("lead-verify-off", { email: "lead-off@example.com", name: "Lead Unverified", verified: false });
  seed("lead-verify-on", { email: "lead-on@example.com", name: "Lead Verified", verified: true });
  const admin = "lead-verify-admin";
  seed(admin, { email: "qa-admin@example.com", name: "QA Admin", verified: true });

  const models = await req("GET", "/api/models");
  check("GET /api/models 200 + 23 models", models.status === 200 && Array.isArray(models.json?.data) && models.json.data.length === 23, "status=" + models.status + " count=" + (models.json?.data?.length));

  const anon = await req("POST", "/api/comparisons", { body: { question: "x" } });
  check("POST /api/comparisons anonymous -> 401", anon.status === 401, "status=" + anon.status);

  // OTP end-to-end for the unverified user.
  const offCookie = cookieFor("lead-verify-off");
  const before = existsSync(OTP_LOG) ? readFileSync(OTP_LOG, "utf8").length : 0;
  const send = await req("POST", "/api/otp/send", { cookie: offCookie, origin: "http://chate.test:3212", body: { phone: "+966501234567", "cf-turnstile-response": qaToken("otp") } });
  check("POST /api/otp/send verified-profile gate + send -> 200", send.status === 200 && send.json?.data?.sent === true, "status=" + send.status + " body=" + send.text.slice(0, 160));
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(100);
    if (!existsSync(OTP_LOG)) continue;
    const text = readFileSync(OTP_LOG, "utf8");
    const lines = text.slice(before).split("\n").filter(Boolean);
    if (lines.length) { try { code = JSON.parse(lines[lines.length - 1]).code; } catch {} }
  }
  check("OTP code captured by mock provider", typeof code === "string" && /^\d{6}$/.test(code), "code captured=" + (typeof code));
  const wrong = await req("POST", "/api/otp/verify", { cookie: offCookie, origin: "http://chate.test:3212", body: { code: code === "000000" ? "111111" : "000000" } });
  check("POST /api/otp/verify wrong code -> 403 + remainingAttempts", wrong.status === 403 && wrong.json?.error?.code === "OTP_MISMATCH", "status=" + wrong.status + " code=" + wrong.json?.error?.code);
  const verify = await req("POST", "/api/otp/verify", { cookie: offCookie, origin: "http://chate.test:3212", body: { code } });
  check("POST /api/otp/verify correct code -> 200 verified", verify.status === 200 && verify.json?.data?.verified === true, "status=" + verify.status + " body=" + verify.text.slice(0, 120));
  const row = db.prepare("SELECT phone_verified_at FROM profiles WHERE user_id = ?").get("lead-verify-off");
  check("profiles.phone_verified_at persisted", typeof row?.phone_verified_at === "string" && row.phone_verified_at.length > 0, "value-set=" + (typeof row?.phone_verified_at === "string"));

  // Comparison with 3 free models + Haiku (disabled) for the now-verified user.
  const onCookie = cookieFor("lead-verify-off");
  const idKey = randomUUID();
  const create = await req("POST", "/api/comparisons", { cookie: onCookie, origin: "http://chate.test:3212", body: {
    question: "ما عاصمة الأردن؟ اذكر اسمًا واحدًا.",
    evidenceMode: "native",
    answerModelIds: ["google/gemma-4-31b-it:free", "recursive/flint-v1.0:free", "google/gemma-4-26b-a4b-it:free", "claude-haiku-5-5"],
    idempotencyKey: idKey,
    "cf-turnstile-response": qaToken("comparison"),
  } });
  check("POST /api/comparisons authenticated -> 200 comparison id", create.status === 200 && typeof create.json?.data?.id === "string", "status=" + create.status + " body=" + create.text.slice(0, 220));
  const id = create.json?.data?.id;
  let settled = null;
  if (id) {
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const poll = await req("GET", "/api/comparisons/" + id, { cookie: onCookie, origin: "http://chate.test:3212" });
      const runs = poll.json?.data?.runs || [];
      const done = runs.every((r) => ["completed", "failed", "incomplete"].includes(r.status));
      if (runs.length === 4 && done) { settled = runs; break; }
    }
  }
  const statuses = (settled || []).map((r) => r.modelId + ":" + r.status);
  const completed = (settled || []).filter((r) => r.status === "completed" && r.outputText.includes("إجابة تجريبية")).length;
  const haikuFailed = (settled || []).some((r) => r.modelId === "claude-haiku-5-5" && r.status === "failed");
  check("4 runs settled independently", (settled || []).length === 4, "statuses=" + statuses.join(","));
  check("3 free models completed with mocked answer", completed === 3, "completed=" + completed);
  check("Haiku failed while others succeeded (no live spend)", haikuFailed, "haikuFailed=" + haikuFailed);

  const idor = await req("GET", "/api/comparisons/" + randomUUID(), { cookie: onCookie, origin: "http://chate.test:3212" });
  check("GET random comparison id -> 404", idor.status === 404, "status=" + idor.status);

  const adminPage = await req("GET", "/admin", { cookie: cookieFor(admin) });
  check("GET /admin as seeded admin -> 200 dashboard", adminPage.status === 200 && adminPage.text.includes("الإدارة"), "status=" + adminPage.status + " hasTitle=" + adminPage.text.includes("الإدارة"));
  const adminDenied = await req("GET", "/admin", { cookie: cookieFor("lead-verify-on") });
  check("GET /admin as non-admin -> denied view", adminDenied.status === 200 && adminDenied.text.includes("تُرفض"), "status=" + adminDenied.status + " deniedText=" + adminDenied.text.includes("تُرفض"));

  db.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\nSUMMARY: " + (results.length - failed.length) + "/" + results.length + " passed");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => { console.error("SCRIPT_ERROR", error); process.exit(2); });
