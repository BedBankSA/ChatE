#!/usr/bin/env node
/**
 * measure-resources.mjs - zero-dependency process resource sampler for ChatE.
 *
 * Finds the server PID (by --port or --pid) and samples, from outside the
 * process: working set (RSS), private bytes, PSS, CPU%, handles, threads and
 * cumulative disk I/O. Windows-first; on macOS/Linux it falls back to ps.
 *
 * It never restarts, signals or attaches to the server.
 *
 * Usage:
 *   node scripts/bench/measure-resources.mjs --port=3211 --duration=15
 *   node scripts/bench/measure-resources.mjs --pid=1234 --json --out=rss.json
 *
 * Flags: --port, --pid, --duration (s), --interval (ms), --json, --out=path
 */
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = opt("port", "3211");
const DURATION_S = Number(opt("duration", "15"));
const INTERVAL_MS = Number(opt("interval", "1000"));
const JSON_OUT = flag("json");
const OUT = opt("out", null);
const IS_WINDOWS = process.platform === "win32";
const result = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  machine: { cores: os.cpus().length, totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), loadAvg: os.loadavg() },
  target: null,
  samples: [],
  summary: null,
  warnings: [],
};

function resolvePid() {
  const explicit = opt("pid", null);
  if (explicit) return Number(explicit);
  if (IS_WINDOWS) {
    const text = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 10000 });
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = Number(parts[parts.length - 1]);
      if (local.endsWith(":" + PORT) && Number.isFinite(pid)) return pid;
    }
    return null;
  }
  try {
    const text = execFileSync("lsof", ["-nP", "-iTCP:" + PORT, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 10000 });
    const pid = Number(text.trim().split(/\r?\n/)[0]);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

const PID = resolvePid();
if (!PID) { console.error("could not resolve a PID listening on port " + PORT + "; pass --pid=<pid>"); process.exit(2); }

function processInfoWindows(pid) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$p = Get-CimInstance Win32_Process -Filter ('ProcessId = " + pid + "')",
    "$proc = Get-Process -Id " + pid + " -ErrorAction SilentlyContinue",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "[pscustomobject]@{",
    "  pid = " + pid + ";",
    "  name = $proc.ProcessName;",
    "  commandLine = $p.CommandLine;",
    "  startTime = if ($proc.StartTime) { $proc.StartTime.ToUniversalTime().ToString('o') } else { $null };",
    "  machineCores = $os.NumberOfLogicalProcessors;",
    "  machineMemBytes = [int64]$os.TotalVisibleMemorySize * 1024;",
    "  machineMemFreeBytes = [int64]$os.FreePhysicalMemory * 1024",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000 });
    return JSON.parse(output.trim());
  } catch (error) {
    result.warnings.push("process info failed: " + String(error).slice(0, 150));
    return {};
  }
}

function processInfoPosix(pid) {
  try {
    const ps = "ps -o pid=,rss=,pcpu=,etime=,comm= -p " + pid;
    const line = execFileSync("sh", ["-c", ps], { encoding: "utf8", timeout: 10000 }).trim();
    const parts = line.split(/\s+/);
    return { pid, name: parts.slice(4).join(" "), rssKb: Number(parts[1]), pcpu: Number(parts[2]), etime: parts[3] };
  } catch (error) {
    result.warnings.push("ps failed: " + String(error).slice(0, 150));
    return {};
  }
}

result.target = IS_WINDOWS ? { pid: PID, ...processInfoWindows(PID), resolvedVia: opt("pid", null) ? "explicit" : "port " + PORT } : { pid: PID, ...processInfoPosix(PID) };

// --- Windows sampler: one PowerShell process emits one JSON line per tick --
const PSS_CS = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class PssProbe {",
  "  [StructLayout(LayoutKind.Sequential)] public struct MEMORY_BASIC_INFORMATION {",
  "    public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;",
  "    public UIntPtr RegionSize; public uint State; public uint Protect; public uint Type;",
  "  }",
  "  [StructLayout(LayoutKind.Sequential)] public struct WORKING_SET_EX_INFORMATION {",
  "    public IntPtr VirtualAddress; public IntPtr VirtualAttributes;",
  "  }",
  "  [DllImport(\"kernel32.dll\")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);",
  "  [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle);",
  "  [DllImport(\"kernel32.dll\")] static extern IntPtr VirtualQueryEx(IntPtr hProcess, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);",
  "  [DllImport(\"psapi.dll\")] static extern bool QueryWorkingSetEx(IntPtr hProcess, [In, Out] WORKING_SET_EX_INFORMATION[] info, int length);",
  "  public static long Pss(int pid) {",
  "    IntPtr h = OpenProcess(0x1000 | 0x0400, false, pid);",
  "    if (h == IntPtr.Zero) throw new Exception(\"OpenProcess failed\");",
  "    long total = 0; IntPtr address = IntPtr.Zero; int page = 4096;",
  "    int structSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));",
  "    try {",
  "      while (true) {",
  "        MEMORY_BASIC_INFORMATION info;",
  "        if (VirtualQueryEx(h, address, out info, (IntPtr)structSize) == IntPtr.Zero) break;",
  "        long regionSize = (long)info.RegionSize.ToUInt64();",
  "        if (info.State == 0x1000 && regionSize > 0 && regionSize < (1L << 30)) {",
  "          int pages = (int)(regionSize / page);",
  "          if (pages > 0) {",
  "            var arr = new WORKING_SET_EX_INFORMATION[pages];",
  "            for (int i = 0; i < pages; i++) { arr[i].VirtualAddress = new IntPtr(address.ToInt64() + (long)i * page); }",
  "            if (QueryWorkingSetEx(h, arr, pages * Marshal.SizeOf(typeof(WORKING_SET_EX_INFORMATION)))) {",
  "              for (int i = 0; i < pages; i++) { if (((long)arr[i].VirtualAttributes.ToInt64() & 1L) != 0) total += page; }",
  "            }",
  "          }",
  "        }",
  "        long next = address.ToInt64() + regionSize;",
  "        if (next <= address.ToInt64()) break;",
  "        address = new IntPtr(next);",
  "      }",
  "    } finally { CloseHandle(h); }",
  "    return total;",
  "  }",
  "}",
].join("\n");

function windowsSamplerScript() {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    PSS_CS,
    "'@",
    "$pidTarget = " + PID,
    "$interval = " + INTERVAL_MS,
    "$iterations = " + Math.max(1, Math.round((DURATION_S * 1000) / INTERVAL_MS)),
    "$cores = [Environment]::ProcessorCount",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "$freeStart = [int64]$os.FreePhysicalMemory * 1024",
    "$proc = Get-Process -Id $pidTarget",
    "$lastCpu = $proc.TotalProcessorTime.TotalMilliseconds",
    "$lastWall = [DateTime]::UtcNow",
    "$first = $true",
    "for ($i = 0; $i -lt $iterations; $i++) {",
    "  Start-Sleep -Milliseconds $interval",
    "  $p = Get-Process -Id $pidTarget -ErrorAction SilentlyContinue",
    "  if (-not $p) { break }",
    "  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter ('IDProcess = ' + $pidTarget) -ErrorAction SilentlyContinue",
    "  # PercentProcessorTime is 0-100 across the whole machine; multiply by cores",
    "  # for the familiar single-core percentage.",
    "  $machinePct = if ($perf) { [double]$perf.PercentProcessorTime } else { 0 }",
    "  if ($machinePct -lt 0) { $machinePct = 0 }",
    "  $info = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $pidTarget)",
    "  $pss = $null",
    "  try { $pss = [PssProbe]::Pss($pidTarget) } catch { $pss = $null }",
    "  [pscustomobject]@{",
    "    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();",
    "    cpuPctOneCore = [math]::Round($machinePct * $cores, 2);",
    "    cpuPctMachine = [math]::Round($machinePct, 2);",
    "    rssMB = [math]::Round($p.WorkingSet64 / 1MB, 2);",
    "    privateMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 2);",
    "    pssMB = if ($pss -ne $null) { [math]::Round($pss / 1MB, 2) } else { $null };",
    "    handles = $p.HandleCount;",
    "    threads = $p.Threads.Count;",
    "    readMB = [math]::Round(([int64]$info.ReadTransferCount) / 1MB, 2);",
    "    writeMB = [math]::Round(([int64]$info.WriteTransferCount) / 1MB, 2);",
    "    freeMemMB = [math]::Round(([int64]$os.FreePhysicalMemory) * 1024 / 1MB, 1)",
    "  } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
}

function parseSamples(stdout) {
  const samples = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { samples.push(JSON.parse(trimmed)); } catch {}
  }
  return samples;
}

if (IS_WINDOWS) {
  const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsSamplerScript()], { encoding: "utf8", timeout: (DURATION_S + 30) * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (child.error) result.warnings.push("sampler failed: " + String(child.error).slice(0, 200));
  result.samples = parseSamples(child.stdout || "");
  if (child.stderr && child.stderr.trim()) result.warnings.push("sampler stderr: " + child.stderr.trim().slice(0, 400));
} else {
  const samples = [];
  const started = Date.now();
  const interval = Math.max(200, INTERVAL_MS);
  let last = started;
  while (Date.now() - started < DURATION_S * 1000) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const now = Date.now();
    const info = processInfoPosix(PID);
    samples.push({ t: now, rssMB: (info.rssKb || 0) / 1024, cpuPctOneCore: info.pcpu ?? null, intervalMs: now - last });
    last = now;
  }
  result.samples = samples;
}

function stats(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const pct = (p) => clean[Math.min(clean.length - 1, Math.floor((clean.length - 1) * p))];
  return { min: clean[0], p50: pct(0.5), p95: pct(0.95), max: clean[clean.length - 1], mean: clean.reduce((a, b) => a + b, 0) / clean.length };
}

const samples = result.samples;
result.summary = {
  sampleCount: samples.length,
  durationSeconds: samples.length ? Math.round((samples[samples.length - 1].t - samples[0].t) / 100) / 10 : 0,
  rssMB: stats(samples.map((s) => s.rssMB)),
  privateMB: stats(samples.map((s) => s.privateMB)),
  pssMB: stats(samples.map((s) => s.pssMB)),
  cpuPctOneCore: stats(samples.map((s) => s.cpuPctOneCore)),
  cpuPctMachine: stats(samples.map((s) => s.cpuPctMachine)),
  handles: stats(samples.map((s) => s.handles)),
  threads: stats(samples.map((s) => s.threads)),
  rssGrowthMB: samples.length > 1 ? Math.round((samples[samples.length - 1].rssMB - samples[0].rssMB) * 100) / 100 : null,
  pssGrowthMB: samples.length > 1 && samples[0].pssMB != null ? Math.round((samples[samples.length - 1].pssMB - samples[0].pssMB) * 100) / 100 : null,
  readMBTotal: samples.length ? samples[samples.length - 1].readMB : null,
  writeMBTotal: samples.length ? samples[samples.length - 1].writeMB : null,
  machineFreeMemMB: samples.length ? samples[samples.length - 1].freeMemMB : null,
  headroom512MB: samples.length ? Math.round((512 - samples[samples.length - 1].rssMB) * 10) / 10 : null,
  headroom1024MB: samples.length ? Math.round((1024 - samples[samples.length - 1].rssMB) * 10) / 10 : null,
};
if (result.summary.rssMB && result.summary.rssMB.max > 512) result.warnings.push("RSS exceeds 512 MB; a 512 MB container would OOM-kill the process");
else if (result.summary.rssMB && result.summary.rssMB.max > 400) result.warnings.push("RSS is above 400 MB; 512 MB container leaves little headroom");

const fmt = (value, digits = 2) => value == null ? "n/a" : Number(value).toFixed(digits);
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  console.log("ChatE resource sampler  pid=" + PID + "  " + (result.target.name || "") + "  port=" + PORT);
  console.log("started: " + (result.target.startTime || "unknown") + "   command: " + String(result.target.commandLine || "").slice(0, 120));
  console.log("machine: " + result.machine.cores + " cores, " + (result.machine.totalMemBytes / 1073741824).toFixed(1) + " GB RAM, free " + (result.machine.freeMemBytes / 1048576).toFixed(0) + " MB at script start");
  console.log("samples: " + result.summary.sampleCount + " over " + result.summary.durationSeconds + " s");
  const s = result.summary;
  console.log("  RSS MB        p50 " + fmt(s.rssMB?.p50) + " | p95 " + fmt(s.rssMB?.p95) + " | max " + fmt(s.rssMB?.max) + "   growth " + fmt(s.rssGrowthMB) + " MB");
  console.log("  Private MB    p50 " + fmt(s.privateMB?.p50) + " | p95 " + fmt(s.privateMB?.p95) + " | max " + fmt(s.privateMB?.max));
  console.log("  PSS MB        " + (s.pssMB ? "p50 " + fmt(s.pssMB.p50) + " | max " + fmt(s.pssMB.max) : "unavailable (sampler failed)"));
  console.log("  CPU % (1 core) p50 " + fmt(s.cpuPctOneCore?.p50) + " | p95 " + fmt(s.cpuPctOneCore?.p95) + " | max " + fmt(s.cpuPctOneCore?.max) + "   machine-normalised p95 " + fmt(s.cpuPctMachine?.p95));
  console.log("  handles       p50 " + fmt(s.handles?.p50, 0) + " | threads p50 " + fmt(s.threads?.p50, 0));
  console.log("  disk I/O      read " + fmt(s.readMBTotal, 1) + " MB | written " + fmt(s.writeMBTotal, 1) + " MB (cumulative)");
  console.log("  headroom      vs 512 MB: " + fmt(s.headroom512MB, 1) + " MB | vs 1024 MB: " + fmt(s.headroom1024MB, 1) + " MB");
  if (result.warnings.length) { console.log(""); console.log("WARNINGS:"); for (const warning of result.warnings) console.log("  " + warning); }
}
if (OUT) writeFileSync(path.resolve(OUT), JSON.stringify(result, null, 2));
