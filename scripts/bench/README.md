# ChatE benchmark kit (zero dependency)

Four Node 24 scripts that measure the shipped artifacts and the running ChatE
server without installing anything and without touching application code.

\`\`\`
scripts/bench/
  build-stats.mjs        parse .next/ production artifacts: per-route JS/CSS/fonts, dead deps
  measure-pages.mjs      HTTP latency/throughput at concurrency 1/10/50 (keep-alive)
  measure-resources.mjs  RSS/PSS/CPU/handles/IO of the running server PID
  inspect-db.mjs         copy of data/chate.sqlite: sizes, indexes, query plans, growth, retention
  tmp/                   scratch copies produced by the scripts (safe to delete)
\`\`\`

Node may not be on PATH on this machine; use the bundled binary:

\`\`\`powershell
$NODE = "C:\Pak\node.exe"
\`\`\`

## 1. build-stats.mjs - client payload and dependency weight

Reads \`.next/diagnostics/route-bundle-stats.json\` (written by \`next build\` in
Next.js 16), \`.next/server/next-font-manifest.json\`, all client chunks and the
server \`.nft.json\` traces. It never runs a build.

\`\`\`powershell
& $NODE scripts/bench/build-stats.mjs
& $NODE scripts/bench/build-stats.mjs --json --out scripts/bench/tmp/build-stats.json
\`\`\`

Expected output (fresh production build): a shared first-load JS line, CSS and
font totals, one line per page route with JS/CSS/fonts gzip and brotli totals,
the \`RUNTIME DEPENDENCIES\` table (imported / client / serverTrace / install
size) and a \`DEAD RUNTIME DEPENDENCIES\` count. If \`.next\` is a dev cache or is
being rebuilt you will see \`missing chunk\` warnings - rerun after the Lead's
\`next build\` finishes.

Notes:
- gzip is zlib level 9, brotli is quality 11, both computed from artifact bytes.
  Real CDN negotiation may differ slightly.
- "first load" = root shared chunks + route-only chunks + the App Router CSS
  file + the woff2 files listed for that route in the font manifest. It does
  not include the HTML document or RSC flight data, which are dynamic here.
- \`client\`/\`serverTrace\` are corroboration only; \`imported\` is the authority
  for whether \`src/\` imports the package.

## 2. measure-pages.mjs - latency and throughput

GET/HEAD-only. The target list contains no write endpoint and nothing that
triggers a model provider call, so it is safe to point at a production server
with live provider keys.

\`\`\`powershell
& $NODE scripts/bench/measure-pages.mjs --base=http://127.0.0.1:3211
& $NODE scripts/bench/measure-pages.mjs --base=http://127.0.0.1:3211 --concurrency=1,10,50 --requests=100 --json --out scripts/bench/tmp/pages.json
& $NODE scripts/bench/measure-pages.mjs --only=home,api-models --requests=50
\`\`\`

Flags: \`--base\`, \`--concurrency\` (csv), \`--requests\` (per target at c=1, total
for concurrent levels), \`--warmup\`, \`--timeout\`, \`--only\`, \`--json\`,
\`--out=\`, \`--raw=\`, \`--no-warmup\`.

Expected output: a sequential table per target (status, p50, p95, TTFB p50,
average bytes) and, per concurrent level, p50/p95/p99, TTFB p50/p95, error
count, status mix, throughput in req/s and per-target p50/p95.

**Record the server mode with every run.** A Turbopack dev server is several
times slower and much larger than \`next start\`; numbers from the two are not
comparable. Check the mode with the page HTML (dev contains
\`hmr-client\`/\`next-devtools\` chunks) or from the build id.

## 3. measure-resources.mjs - server process footprint

Resolves the PID from the listening port (or \`--pid\`) and samples it from
outside. It never restarts, signals or attaches to the process.

\`\`\`powershell
& $NODE scripts/bench/measure-resources.mjs --port=3211 --duration=15
& $NODE scripts/bench/measure-resources.mjs --port=3211 --duration=30 --json --out scripts/bench/tmp/rss-idle.json
\`\`\`

For CPU under load, run \`measure-pages.mjs\` in one terminal and
\`measure-resources.mjs --duration=30\` in another; the sampler reports CPU%,
RSS, private bytes, PSS, handles, threads and cumulative disk I/O.

PSS is computed with \`QueryWorkingSetEx\` through a small inline C# helper; if
the helper cannot be compiled the script reports \`PSS unavailable\` and falls
back to RSS + private bytes.

Expected output: process command line and start time, machine cores/RAM, a
sample count, RSS/private/PSS p50-p95-max with growth, CPU% per core and
machine-normalised, handles/threads, disk I/O totals and headroom against
512 MB and 1024 MB containers.

## 4. inspect-db.mjs - schema, plans, growth on a copy

Copies \`data/chate.sqlite\` (+ \`-wal\`/\`-shm\`) into \`scripts/bench/tmp/\`, opens
the copy, and never writes the live database.

\`\`\`powershell
& $NODE scripts/bench/inspect-db.mjs
& $NODE scripts/bench/inspect-db.mjs --simulate=1000
& $NODE scripts/bench/inspect-db.mjs --json --out scripts/bench/tmp/db.json --keep
\`\`\`

Flags: \`--db=\`, \`--copy-dir=\`, \`--simulate=<comparisons>\`, \`--keep\`, \`--json\`,
\`--out=\`.

The growth simulation inserts synthetic comparisons into a throwaway copy under
these assumptions (they are printed in the output and must be repeated in any
report): 3 free OpenRouter models + Claude Haiku per comparison, 120-character
question, 1,200-character answer per model, ~200-byte evidence snapshot and six
\`operation_stats\` rows per comparison. Arabic text is UTF-8, so 1,200 Arabic
characters are ~2.4 KB before SQLite overhead.

Expected output: source/copy sizes, pragmas (page size, WAL, synchronous,
cache_size, mmap_size), integrity result, vacuumed backup size, table row/byte
sizes, all indexes, \`EXPLAIN QUERY PLAN\` for the hot queries with file:line of
the originating code, possible unindexed scans, bytes per comparison and per
1,000 comparisons, and the retention-gap summary.

## Safety rules used by all scripts

- No \`npm run build\`, no \`next dev/start\`, no process kill, no migrations, no
  writes to \`data/\`, no secrets read or printed, no provider API calls.
- Only temporary copies under \`scripts/bench/tmp/\` are written; delete that
  folder freely.
