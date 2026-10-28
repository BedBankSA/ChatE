#!/usr/bin/env node
/**
 * build-stats.mjs - zero-dependency Next.js 16 build-artifact analyzer for ChatE.
 *
 * Reads the PRODUCTION build in .next/ (never runs a build) and reports:
 *  - per-route first-load JS/CSS/font payload, raw + gzip -9 + brotli -q11
 *  - shared baseline vs per-route extra chunks
 *  - dev-server asset weight (.next/dev/static) for comparison
 *  - declared package.json dependencies that are never imported (dead weight)
 *  - whether dead dependencies leaked into the client or server bundles
 *
 * Usage:
 *   node scripts/bench/build-stats.mjs                 # human table
 *   node scripts/bench/build-stats.mjs --json          # machine JSON
 *   node scripts/bench/build-stats.mjs --out stats.json
 *
 * No network access, no build, read-only on .next and node_modules.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ROOT = path.resolve(opt("root", process.cwd()));
const NEXT = path.join(ROOT, ".next");
const out = { generatedAt: new Date().toISOString(), root: ROOT, buildId: null, mode: null, routes: [], shared: null, fonts: [], css: [], dev: null, deps: null, warnings: [] };

function warn(message) { out.warnings.push(message); }

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function fileStats(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  try {
    const buf = readFileSync(abs);
    return {
      file: path.relative(ROOT, abs).replaceAll("\\", "/"),
      raw: buf.length,
      gzip: gzipSync(buf, { level: 9 }).length,
      brotli: brotliCompressSync(buf, { params: { [require_brotliQuality()]: 11 } }).length,
    };
  } catch {
    warn("missing chunk: " + file);
    return { file: String(file).replaceAll("\\", "/"), raw: 0, gzip: 0, brotli: 0, missing: true };
  }
}

// zlib brotli quality constant is 1 in Node's constants; avoid importing constants dynamically.
function require_brotliQuality() {
  return 1; // zlib.constants.BROTLI_PARAM_QUALITY
}

function sum(rows, key) { return rows.reduce((acc, row) => acc + (row[key] || 0), 0); }

if (!existsSync(NEXT)) {
  console.error("No .next directory at " + NEXT + " - run \x60npm run build\x60 first (this script never builds).");
  process.exit(2);
}

out.buildId = existsSync(path.join(NEXT, "BUILD_ID")) ? readFileSync(path.join(NEXT, "BUILD_ID"), "utf8").trim() : null;
out.mode = out.buildId ? "production build" : "dev cache only";

// --- 1. Route JS from the build's own diagnostics -------------------------
let routeStats = readJson(path.join(NEXT, "diagnostics", "route-bundle-stats.json"), null);
if (!Array.isArray(routeStats) || routeStats.length === 0) {
  warn("route-bundle-stats.json missing; falling back to client-reference manifests");
  routeStats = fallbackRoutes();
}

function fallbackRoutes() {
  const appDir = path.join(NEXT, "server", "app");
  const routes = [];
  walk(appDir);
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith("page_client-reference-manifest.js")) continue;
      const rel = path.relative(appDir, path.dirname(full)).replaceAll("\\", "/");
      const route = rel === "" || rel === "." ? "/" : "/" + rel;
      const text = readFileSync(full, "utf8");
      const chunks = new Set();
      for (const m of text.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9._%-]+\.js)/g)) {
        if (!m[1].includes("server")) chunks.add(".next/static/chunks/" + m[1]);
      }
      routes.push({ route, firstLoadChunkPaths: [...chunks], firstLoadUncompressedJsBytes: null });
    }
  }
  return routes;
}

// --- 2. Shared chunks (present on every page route) ----------------------
const pageRoutes = routeStats.filter((r) => !r.route.startsWith("/api") && !r.route.startsWith("/_"));
const counts = new Map();
for (const route of pageRoutes) for (const chunk of route.firstLoadChunkPaths || []) counts.set(chunk, (counts.get(chunk) || 0) + 1);
const sharedPaths = [...counts.entries()].filter(([, n]) => n === pageRoutes.length).map(([chunk]) => chunk);
const sharedStats = sharedPaths.map((p) => fileStats(p));
out.shared = { chunks: sharedStats, raw: sum(sharedStats, "raw"), gzip: sum(sharedStats, "gzip"), brotli: sum(sharedStats, "brotli") };

// --- 3. CSS (App Router global stylesheet; attributed to every page) -----
function walkStatic(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkStatic(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}
out.css = walkStatic(path.join(NEXT, "static"), ".css").map((p) => fileStats(p));

// --- 4. Fonts declared per route in next/font manifest -------------------
const fontManifest = readJson(path.join(NEXT, "server", "next-font-manifest.json"), null);
const appFonts = fontManifest && fontManifest.app ? fontManifest.app : {};
const fontFiles = new Map();
for (const list of Object.values(appFonts)) {
  for (const file of list || []) {
    if (!fontFiles.has(file)) fontFiles.set(file, fileStats(".next/" + String(file).replaceAll("\\", "/")));
  }
}
out.fonts = [...fontFiles.values()];

function fontsForRoute(routePath) {
  const key = routePath === "/" ? "[project]/src/app/page" : "[project]/src/app" + routePath + "/page";
  const list = appFonts[key] || [];
  const stats = list.map((f) => fontFiles.get(f)).filter(Boolean);
  return { files: stats, raw: sum(stats, "raw"), gzip: sum(stats, "gzip"), brotli: sum(stats, "brotli") };
}

// --- 5. Per-route table ---------------------------------------------------
for (const route of routeStats) {
  const chunkPaths = route.firstLoadChunkPaths || [];
  const own = chunkPaths.filter((p) => !sharedPaths.includes(p)).map((p) => fileStats(p));
  const fonts = fontsForRoute(route.route);
  const cssRaw = sum(out.css, "raw"), cssGzip = sum(out.css, "gzip"), cssBrotli = sum(out.css, "brotli");
  out.routes.push({
    route: route.route,
    js: { own, ownRaw: sum(own, "raw"), ownGzip: sum(own, "gzip"), ownBrotli: sum(own, "brotli"),
      totalRaw: sum(own, "raw") + out.shared.raw, totalGzip: sum(own, "gzip") + out.shared.gzip, totalBrotli: sum(own, "brotli") + out.shared.brotli },
    css: { raw: cssRaw, gzip: cssGzip, brotli: cssBrotli },
    fonts,
    firstLoad: {
      raw: sum(own, "raw") + out.shared.raw + cssRaw + fonts.raw,
      gzip: sum(own, "gzip") + out.shared.gzip + cssGzip + fonts.gzip,
      brotli: sum(own, "brotli") + out.shared.brotli + cssBrotli + fonts.brotli,
    },
    buildReportedUncompressedJs: route.firstLoadUncompressedJsBytes ?? null,
  });
}

// --- 6. Dev-server assets (for contrast only; not shipped in prod) ------
const devStatic = path.join(NEXT, "dev", "static");
if (existsSync(devStatic)) {
  const files = walkStatic(devStatic, ".js").concat(walkStatic(devStatic, ".css"));
  const stats = files.map((p) => fileStats(p));
  out.dev = { files: stats.length, raw: sum(stats, "raw"), gzip: sum(stats, "gzip"), brotli: sum(stats, "brotli") };
}

// --- 7. Dependency / install-weight analysis ------------------------------
const pkg = readJson(path.join(ROOT, "package.json"), { dependencies: {}, devDependencies: {} });
const runtimeDeps = Object.keys(pkg.dependencies || {});
const devDeps = Object.keys(pkg.devDependencies || {});
const ESSENTIAL = new Set(["next", "react", "react-dom", "google-auth-library"]);
// Markers are library-specific identifiers that survive minification. The
// per-page chunk loading map is the authority for imports, this is corroboration.
const MARKERS = {
  "@tanstack/react-table": ["@tanstack/table-core", "getCoreRowModel"],
  "@tremor/react": ["@tremor/react", "recharts", "tremor"],
  jszip: ["JSZip", "jszip"],
  mammoth: ["mammoth"],
  "word-extractor": ["word-extractor"],
  unpdf: ["unpdf", "pdfjs"],
  "libphonenumber-js": ["libphonenumber", "parsePhoneNumberFromString"],
  "google-auth-library": ["google-auth-library", "OAuth2Client"],
  "@radix-ui/react-slot": ["@radix-ui/react-slot", "SlotClone"],
  "class-variance-authority": ["class-variance-authority"],
  clsx: ["clsx"],
  "tailwind-merge": ["tailwind-merge", "twMerge"],
  zod: ["zod"],
};
const scanFiles = [];
function scanTree(dir, acc) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanTree(full, acc);
    else if (/\.(m?[jt]sx?|css)$/.test(entry.name)) acc.push(full);
  }
}
scanTree(path.join(ROOT, "src"), scanFiles);
scanTree(path.join(ROOT, "scripts"), scanFiles);
for (const file of ["next.config.ts", "vitest.config.ts", "postcss.config.mjs"]) {
  if (existsSync(path.join(ROOT, file))) scanFiles.push(path.join(ROOT, file));
}
const importRe = /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["'])/g;
const importedTopLevel = new Set();
for (const file of scanFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(importRe)) {
    const spec = match[1] || match[2] || match[3];
    if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
    importedTopLevel.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  }
}
const clientChunks = walkStatic(path.join(NEXT, "static"), ".js");
const clientText = clientChunks.map((p) => readFileSync(p, "utf8")).join("");
const traceFiles = [];
(function walkTraces(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTraces(full);
    else if (entry.name.endsWith(".nft.json")) traceFiles.push(full);
  }
})(path.join(NEXT, "server"));
const tracedPaths = [];
for (const file of traceFiles) {
  const json = readJson(file, null);
  if (json && Array.isArray(json.files)) for (const item of json.files) tracedPaths.push(String(item).replaceAll("\\", "/"));
}
const tracedText = tracedPaths.join("\n");
const nodeModules = path.join(ROOT, "node_modules");
// One traversal of node_modules; per-package subtotals are reused for every
// dependency. Scoped packages (@scope/name) are aggregated at the top level.
function nodeModulesSizes() {
  const sizes = new Map();
  let total = 0, files = 0;
  let topLevel = [];
  try { topLevel = readdirSync(nodeModules, { withFileTypes: true }); } catch { return { sizes, total, files }; }
  const stack = [];
  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue;
    const full = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      let scoped = [];
      try { scoped = readdirSync(full, { withFileTypes: true }); } catch {}
      for (const sub of scoped) {
        if (!sub.isDirectory()) continue;
        const key = entry.name + "/" + sub.name;
        stack.push({ key, dir: path.join(full, sub.name) });
        sizes.set(key, { bytes: 0, files: 0 });
      }
    } else {
      stack.push({ key: entry.name, dir: full });
      sizes.set(entry.name, { bytes: 0, files: 0 });
    }
  }
  for (const item of stack) {
    const bucket = sizes.get(item.key);
    const inner = [item.dir];
    while (inner.length) {
      const current = inner.pop();
      let entries = [];
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) inner.push(full);
        else { try { const bytes = statSync(full).size; bucket.bytes += bytes; bucket.files += 1; total += bytes; files += 1; } catch {} }
      }
    }
  }
  return { sizes, total, files };
}
const nodeModuleSizes = nodeModulesSizes();
const dependencyReport = runtimeDeps.map((name) => {
  const installed = existsSync(path.join(nodeModules, name));
  const size = nodeModuleSizes.sizes.get(name) || { bytes: 0, files: 0 };
  const markers = MARKERS[name] || [name];
  const clientBundle = markers.some((marker) => clientText.includes(marker));
  const serverTrace = markers.some((marker) => tracedText.includes("node_modules/" + name + "/")) || tracedText.includes("node_modules/" + name + "/");
  return {
    name,
    imported: importedTopLevel.has(name),
    essential: ESSENTIAL.has(name),
    installed,
    installBytes: size.bytes,
    installFiles: size.files,
    clientBundle,
    serverTrace,
    markers: markers.filter((marker) => clientText.includes(marker) || tracedText.includes("node_modules/" + name + "/")),
  };
});
const deadRuntime = dependencyReport.filter((dep) => !dep.imported && !dep.serverTrace && !dep.essential);
const devUnused = devDeps.filter((name) => !importedTopLevel.has(name));
out.deps = {
  runtime: dependencyReport,
  deadRuntime,
  devUnused,
  devUnusedCount: devUnused.length,
  totalNodeModulesBytes: nodeModuleSizes.total,
  tracedFiles: tracedPaths.length,
  clientChunksScanned: clientChunks.length,
};

// --- 8. Output ------------------------------------------------------------
const kb = (n) => (n / 1024).toFixed(1);
if (flag("json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("ChatE build stats  buildId=" + out.buildId + "  (" + out.mode + ")");
  console.log("All transfer sizes are computed from artifact bytes with gzip -9 / brotli quality 11.\n");
  console.log("SHARED first-load JS (all pages): " + sharedPaths.length + " chunks, raw " + kb(out.shared.raw) + " KB, gzip " + kb(out.shared.gzip) + " KB, br " + kb(out.shared.brotli) + " KB");
  for (const chunk of sharedStats) console.log("  " + kb(chunk.raw).padStart(7) + " KB raw  " + kb(chunk.gzip).padStart(6) + " KB gz  " + chunk.file);
  const css = out.css.reduce((acc, row) => ({ raw: acc.raw + row.raw, gzip: acc.gzip + row.gzip, brotli: acc.brotli + row.brotli }), { raw: 0, gzip: 0, brotli: 0 });
  console.log("\nCSS: " + out.css.length + " file(s), raw " + kb(css.raw) + " KB, gzip " + kb(css.gzip) + " KB, br " + kb(css.brotli) + " KB");
  for (const file of out.css) console.log("  " + kb(file.raw).padStart(7) + " KB raw  " + file.file);
  console.log("\nFONTS: " + out.fonts.length + " woff2 file(s), raw " + kb(sum(out.fonts, "raw")) + " KB, gzip " + kb(sum(out.fonts, "gzip")) + " KB, br " + kb(sum(out.fonts, "brotli")) + " KB");
  for (const file of out.fonts) console.log("  " + kb(file.raw).padStart(7) + " KB raw  " + file.file);
  console.log("\nPER-ROUTE FIRST LOAD (js total gz | css gz | fonts gz | total raw/gz/br)");
  for (const route of out.routes) {
    console.log(
      route.route.padEnd(18) +
      ("js " + kb(route.js.totalGzip) + " KB gz").padEnd(20) +
      ("css " + kb(route.css.gzip) + " KB gz").padEnd(18) +
      ("fonts " + kb(route.fonts.gzip) + " KB gz").padEnd(19) +
      "TOTAL " + kb(route.firstLoad.raw) + " KB raw / " + kb(route.firstLoad.gzip) + " KB gz / " + kb(route.firstLoad.brotli) + " KB br"
    );
    const own = route.js.own.map((c) => c.file.replace(".next/static/chunks/", "") + " (" + kb(c.raw) + " KB)");
    if (own.length) console.log("  route-only chunks: " + own.join(", "));
  }
  if (out.dev) console.log("\nDEV-ONLY assets in .next/dev/static: " + out.dev.files + " js/css files, raw " + kb(out.dev.raw) + " KB, gzip " + kb(out.dev.gzip) + " KB (never shipped; dev server payload is much larger)");
  console.log("");
  console.log("RUNTIME DEPENDENCIES (" + out.deps.runtime.length + "): imported = direct import in src/scripts/config; client = marker in client chunks; serverTrace = path in .nft.json; install = on-disk size");
  for (const dep of out.deps.runtime) {
    console.log("  " + dep.name.padEnd(26) + "imported=" + String(dep.imported).padEnd(6) + "client=" + String(dep.clientBundle).padEnd(7) + "serverTrace=" + String(dep.serverTrace).padEnd(6) + "install=" + (dep.installed ? kb(dep.installBytes) + " KB" : "not installed"));
  }
  console.log("");
  console.log("DEAD RUNTIME DEPENDENCIES (never imported, never traced into the build): " + out.deps.deadRuntime.length);
  for (const dep of out.deps.deadRuntime) console.log("  " + dep.name.padEnd(26) + (dep.installed ? kb(dep.installBytes) + " KB install" : "not installed"));
  console.log("  devDependencies not imported directly: " + out.deps.devUnusedCount + " (tooling; never shipped to browsers)");
  console.log("  total node_modules size: " + kb(out.deps.totalNodeModulesBytes) + "; server trace files parsed: " + out.deps.tracedFiles + "; client chunks scanned: " + out.deps.clientChunksScanned);
  if (out.warnings.length) console.log("\nWARNINGS:\n  " + out.warnings.join("\n  "));
}
if (opt("out", null)) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.resolve(opt("out")), JSON.stringify(out, null, 2));
}
