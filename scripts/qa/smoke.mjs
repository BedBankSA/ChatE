/**
 * Smoke test for the QA CDP harness: launches Chrome, opens the app, captures a
 * screenshot and prints console / network errors. Zero dependencies.
 *
 *   C:\\Pak\\node.exe scripts/qa/smoke.mjs [url]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, stopChrome, CDP, Page, EventCollector } from "./lib/cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] || process.env.QA_BASE_URL || "http://127.0.0.1:3211";

const chrome = await launchChrome();
const cdp = await CDP.connect(chrome.pageTarget.webSocketDebuggerUrl);
const page = new Page(cdp);
const collect = new EventCollector(cdp, { baseUrl: base });
try {
  await page.init();
  await page.setViewport(1440, 900);
  await page.navigate(base + "/");
  console.log("title:", await page.eval("document.title"));
  console.log("h1:", await page.eval("document.querySelector('h1')?.textContent"));
  console.log("dir:", await page.eval("document.documentElement.dir"), "lang:", await page.eval("document.documentElement.lang"));
  const shot = await page.screenshot(path.join(here, "..", "..", "docs", "audit", "screenshots", "_smoke.png"));
  console.log("screenshot:", path.relative(process.cwd(), shot));
  console.log("documents:", JSON.stringify(collect.documents));
  console.log("app errors:", JSON.stringify(collect.appErrors(), null, 2));
  console.log("external:", JSON.stringify(collect.externalNoise().map((e) => e.text + " @ " + e.url), null, 2));
} finally {
  cdp.close();
  await stopChrome(chrome);
}
