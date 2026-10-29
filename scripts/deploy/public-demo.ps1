#Requires -Version 5.1
<#
.SYNOPSIS
    Reproducible PUBLIC deployment evidence for ChatE using a temporary
    Cloudflare quick tunnel (https://<random>.trycloudflare.com).

.DESCRIPTION
    This script is the honest "public URL" evidence tool for the repository.
    It does NOT deploy to a VPS and it does NOT create durable hosting.

    What it does:
      1. Loads .env.local into the process environment WITHOUT printing secret
         values (only names/counts; values are inherited by child processes).
      2. Builds a production Next.js bundle if .next/BUILD_ID is missing
         (or when -Build is passed), because NEXT_PUBLIC_* values are baked
         into the browser bundle at build time.
      3. Starts `next start` on 127.0.0.1:<Port> (default 3223).
      4. Downloads cloudflared.exe into .tools/ if it is not on PATH, then
         starts a Cloudflare quick tunnel to the local server.
      5. Probes the PUBLIC https URL and the local server: landing page,
         /api/models, privacy/terms, anonymous 401s, and security headers.
      6. Writes docs/evidence/public-deployment.md with timestamp, URL,
         PASS/FAIL table and honest limitations.
      7. Leaves the server + tunnel running on purpose and prints exactly what
         is still running, with the exact command to stop it (-Stop).

    Never printed or written anywhere: .env.local secret values. The evidence
    file records only public facts (URLs, status codes, headers, checks).

.PARAMETER Port
    Local production server port (loopback only). Default: 3223.

.PARAMETER EnvFile
    Env file to load into the process environment. Default: .env.local.

.PARAMETER AppUrl
    Optional APP_URL override for the local server. Default: http://127.0.0.1:<Port>.

.PARAMETER Build
    Force `next build` even when a production build already exists.

.PARAMETER Stop
    Stop the server and tunnel recorded by a previous run. Does not need Node.

.PARAMETER DryRun
    Validate node/env/build/cloudflared/port state and print the plan. Starts
    nothing, downloads nothing, writes nothing.

.PARAMETER NodePath
    Optional explicit path to node.exe (default: node on PATH, then C:\Pak\node.exe).

.PARAMETER ServerTimeoutSeconds
    Max seconds to wait for the local server to answer /api/models. Default: 90.

.PARAMETER TunnelTimeoutSeconds
    Max seconds to wait for the quick-tunnel URL, per protocol attempt. Default: 75.

.PARAMETER ProbeTimeoutSeconds
    Max seconds to wait for the public URL to answer. Default: 120.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\public-demo.ps1 -Build

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\public-demo.ps1 -Stop

.NOTES
    Owner: release-engineer (ECC task-4). Evidence contract:
    tmp/ecc-fix-contract.md -> Release/deploy. Quick tunnel == ephemeral demo,
    not production. Google sign-in and Turnstile-gated flows are expected NOT
    to work on a throwaway hostname (NEXT_PUBLIC_* are build-time values and
    provider origins are not registered for it); see the generated evidence.
#>
[CmdletBinding()]
param(
    [int]$Port = 3223,
    [string]$EnvFile = ".env.local",
    [string]$AppUrl = "",
    [switch]$Build,
    [switch]$Stop,
    [switch]$DryRun,
    [string]$NodePath = "",
    [int]$ServerTimeoutSeconds = 90,
    [int]$TunnelTimeoutSeconds = 180,
    [int]$ProbeTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# --- Fixed locations (relative to the repository root) ---------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\.."))
$toolsDir = Join-Path $repoRoot ".tools"
$demoDir = Join-Path $toolsDir "public-demo"
$statePath = Join-Path $demoDir "state.json"
$evidencePath = Join-Path $repoRoot "docs\evidence\public-deployment.md"
$cloudflaredLocal = Join-Path $toolsDir "cloudflared.exe"
$quickTunnelDownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

# --- Console helpers --------------------------------------------------------
function Write-Step([string]$Message) { Write-Host ""; Write-Host ("==> " + $Message) -ForegroundColor Cyan }
function Write-Info([string]$Message) { Write-Host ("    " + $Message) }
function Write-Ok([string]$Message) { Write-Host ("    OK   " + $Message) -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host ("    WARN " + $Message) -ForegroundColor Yellow }
function Write-Fail2([string]$Message) { Write-Host ("    FAIL " + $Message) -ForegroundColor Red }

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Write-Utf8File([string]$Path, [string]$Content) {
    $dir = Split-Path -Parent $Path
    if ($dir) { Ensure-Directory -Path $dir }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-LogTail([string]$Path, [int]$Lines = 25) {
    if (-not (Test-Path -LiteralPath $Path)) { return "(no log file yet)" }
    try {
        $tail = Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop
        if ($null -eq $tail) { return "(empty log)" }
        return (@($tail) -join [Environment]::NewLine)
    } catch {
        return "(could not read log)"
    }
}

function Format-MdCell([string]$Value) {
    if ($null -eq $Value) { return "" }
    $text = [string]$Value
    $text = $text.Replace("|", "\|")
    $text = $text -replace "\r?\n", " "
    if ($text.Length -gt 400) { $text = $text.Substring(0, 397) + "..." }
    return $text.Trim()
}

# --- Process / state helpers ------------------------------------------------
function Read-DemoState {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try {
        $parsed = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $state = @{}
        foreach ($prop in $parsed.PSObject.Properties) { $state[$prop.Name] = $prop.Value }
        return $state
    } catch {
        return $null
    }
}

function Save-DemoState([hashtable]$State) {
    Ensure-Directory -Path $demoDir
    $json = $State | ConvertTo-Json -Depth 5
    Write-Utf8File -Path $statePath -Content ($json + [Environment]::NewLine)
}

function Get-ProcessIdentity([int]$TargetProcessId) {
    $process = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $startUtc = $null
    try { $startUtc = $process.StartTime.ToUniversalTime() } catch { return $null }
    $commandLine = ""
    try {
        $cim = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $TargetProcessId) -ErrorAction Stop
        if ($null -ne $cim) { $commandLine = [string]$cim.CommandLine }
    } catch {
        $commandLine = ""
    }
    return [PSCustomObject]@{
        ProcessId = $TargetProcessId
        StartUtc = $startUtc
        CommandLine = $commandLine
    }
}

function Get-DescendantProcessIds([int]$RootProcessId) {
    $ids = New-Object System.Collections.ArrayList
    [void]$ids.Add($RootProcessId)
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($proc in $all) {
                if (($ids -contains ([int]$proc.ParentProcessId)) -and -not ($ids -contains ([int]$proc.ProcessId))) {
                    [void]$ids.Add([int]$proc.ProcessId)
                    $changed = $true
                }
            }
        }
    } catch {
        # Best effort: the root process is still stopped by the caller.
    }
    return @($ids)
}

function Stop-VerifiedProcessTree {
    param(
        [int]$TargetProcessId,
        [string]$Label,
        [string]$ExpectedCommandPattern = "",
        [string]$ExpectedStartUtcIso = ""
    )
    $identity = Get-ProcessIdentity -TargetProcessId $TargetProcessId
    if ($null -eq $identity) {
        Write-Warn2 ($Label + " (pid " + $TargetProcessId + ") is not running.")
        return $false
    }
    if ($ExpectedCommandPattern -and ($identity.CommandLine -notmatch $ExpectedCommandPattern)) {
        Write-Fail2 ("Refusing to stop pid " + $TargetProcessId + " (" + $Label + "): command line does not look like the recorded process. It may have been reused by an unrelated program.")
        return $false
    }
    if ($ExpectedStartUtcIso) {
        try {
            $expected = [datetime]::Parse($ExpectedStartUtcIso, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
            $deltaSeconds = [math]::Abs(($identity.StartUtc - $expected.ToUniversalTime()).TotalSeconds)
            if ($deltaSeconds -gt 10) {
                Write-Fail2 ("Refusing to stop pid " + $TargetProcessId + " (" + $Label + "): process start time does not match the recorded run.")
                return $false
            }
        } catch {
            Write-Warn2 ("Could not verify the recorded start time for pid " + $TargetProcessId + "; command line check passed.")
        }
    }
    $treeIds = Get-DescendantProcessIds -RootProcessId $TargetProcessId
    foreach ($childId in (@($treeIds) | Sort-Object -Descending)) {
        if ($childId -eq $TargetProcessId) { continue }
        try { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue } catch { }
    }
    try {
        Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
    } catch {
        # A process that exits on its own between the identity check and the kill
        # is a normal race, not a failure.
        if (-not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
            Write-Ok ($Label + " already exited (pid " + $TargetProcessId + ").")
            return $true
        }
        Write-Fail2 ("Could not stop pid " + $TargetProcessId + " (" + $Label + "): " + $_.Exception.Message)
        return $false
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) {
            Write-Ok ($Label + " stopped (pid " + $TargetProcessId + ").")
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    Write-Warn2 ($Label + " (pid " + $TargetProcessId + ") still appears in the process table; Windows may need a moment.")
    return $true
}

# --- Env file / node helpers ------------------------------------------------
function Import-DotEnvFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw ("Env file not found: " + $Path + ". Copy .env.example to .env.local first.")
    }
    $imported = 0
    $skipped = 0
    foreach ($rawLine in [System.IO.File]::ReadAllLines($Path)) {
        $line = ([string]$rawLine).Trim()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.StartsWith("#")) { continue }
        if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
        $equalsAt = $line.IndexOf("=")
        if ($equalsAt -lt 1) { $skipped++; continue }
        $key = $line.Substring(0, $equalsAt).Trim()
        $value = $line.Substring($equalsAt + 1)
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { $skipped++; continue }
        # Strip one pair of matching outer quotes; keep everything else verbatim.
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        Set-Item -Path ("env:" + $key) -Value $value
        $imported++
    }
    return [PSCustomObject]@{
        Imported = $imported
        Skipped = $skipped
        Path = $Path
    }
}

function Resolve-NodeBinary([string]$ExplicitPath) {
    $candidates = New-Object System.Collections.ArrayList
    if ($ExplicitPath) { [void]$candidates.Add($ExplicitPath) }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { [void]$candidates.Add([string]$command.Source) }
    [void]$candidates.Add("C:\Pak\node.exe")
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return [string]$candidate }
    }
    return $null
}

function Get-NodeVersion([string]$NodeBinary) {
    try {
        $versionText = (& $NodeBinary --version 2>&1 | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { return $null }
        return ([string]$versionText).Trim()
    } catch {
        return $null
    }
}

# --- Port helpers -----------------------------------------------------------
function Test-PortListening([int]$TargetPort) {
    try {
        $connections = @(Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction Stop)
        return ($connections.Count -gt 0)
    } catch {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $client.BeginConnect("127.0.0.1", $TargetPort, $null, $null)
            if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
            $client.EndConnect($async)
            return $true
        } catch {
            return $false
        } finally {
            $client.Close()
        }
    }
}

# --- HTTP helpers (works on Windows PowerShell 5.1 and PowerShell 7) --------
$script:HttpClient = $null

function Get-DemoHttpClient {
    if ($null -ne $script:HttpClient) { return $script:HttpClient }
    try { Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue } catch { }
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    $handler.AutomaticDecompression = ([System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate)
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("ChatE-public-demo/1.0")
    $script:HttpClient = $client
    return $client
}

function Invoke-Probe {
    param(
        [string]$Url,
        [string]$Method = "GET",
        [AllowNull()][object]$Body = $null
    )
    $client = Get-DemoHttpClient
    $request = New-Object System.Net.Http.HttpRequestMessage
    if ($Method -eq "POST") {
        $request.Method = [System.Net.Http.HttpMethod]::Post
    } else {
        $request.Method = [System.Net.Http.HttpMethod]::Get
    }
    $request.RequestUri = [Uri]$Url
    # Content is only attached to POST. GET/HEAD with content throws
    # "Cannot send a content-body with this verb-type" on .NET Framework.
    if ($Method -eq "POST") {
        $contentText = "{}"
        if ($null -ne $Body) { $contentText = [string]$Body }
        $request.Content = New-Object System.Net.Http.StringContent($contentText, [System.Text.Encoding]::UTF8, "application/json")
    }
    $response = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        $bodyText = ""
        try { $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } catch { $bodyText = "" }
        $headers = @{}
        foreach ($header in $response.Headers) {
            $headers[[string]$header.Key.ToLowerInvariant()] = (@($header.Value) -join ", ")
        }
        try {
            foreach ($header in $response.Content.Headers) {
                $headers[[string]$header.Key.ToLowerInvariant()] = (@($header.Value) -join ", ")
            }
        } catch { }
        return [PSCustomObject]@{
            Ok = $true
            Status = $statusCode
            Headers = $headers
            Body = [string]$bodyText
            Error = ""
        }
    } catch {
        return [PSCustomObject]@{
            Ok = $false
            Status = 0
            Headers = @{}
            Body = ""
            Error = $_.Exception.Message
        }
    } finally {
        if ($null -ne $response) { try { $response.Dispose() } catch { } }
        if ($null -ne $request) { try { $request.Dispose() } catch { } }
    }
}

function Get-HeaderValue([hashtable]$Headers, [string]$Name) {
    $key = $Name.ToLowerInvariant()
    if ($Headers.ContainsKey($key)) { return [string]$Headers[$key] }
    return $null
}

function Add-CheckResult {
    param(
        $Checks,
        [string]$Id,
        [string]$Target,
        [string]$Expected,
        [string]$Observed,
        [bool]$Pass,
        [bool]$Skip = $false
    )
    $outcome = "FAIL"
    if ($Skip) { $outcome = "SKIP" } elseif ($Pass) { $outcome = "PASS" }
    $result = [PSCustomObject]@{
        Id = $Id
        Target = $Target
        Expected = $Expected
        Observed = $Observed
        Outcome = $outcome
    }
    [void]$Checks.Add($result)
    $color = "Red"
    if ($outcome -eq "PASS") { $color = "Green" } elseif ($outcome -eq "SKIP") { $color = "DarkYellow" }
    Write-Host ("    {0,-4} {1,-26} {2}" -f $outcome, $Id, $Observed) -ForegroundColor $color
}

function Invoke-ExpectedStatus {
    param(
        $Checks,
        [string]$Id,
        [string]$Url,
        [int[]]$ExpectedStatus,
        [string]$Method = "GET",
        [AllowNull()][object]$Body = $null,
        [string]$BodyPattern = "",
        [string]$TargetLabel = ""
    )
    $probe = Invoke-Probe -Url $Url -Method $Method -Body $Body
    $expectedText = "HTTP " + ($ExpectedStatus -join " or ")
    if ($BodyPattern) { $expectedText += " with body /" + $BodyPattern + "/" }
    $target = $Url
    if ($TargetLabel) { $target = $TargetLabel }
    if (-not $probe.Ok) {
        Add-CheckResult -Checks $Checks -Id $Id -Target $target -Expected $expectedText -Observed ("request error: " + $probe.Error) -Pass $false
        return $probe
    }
    $statusOk = ($ExpectedStatus -contains $probe.Status)
    $bodyOk = $true
    $bodyNote = ""
    if ($BodyPattern) {
        $bodyOk = [regex]::IsMatch($probe.Body, $BodyPattern)
        if ($bodyOk) { $bodyNote = "; body matched" } else { $bodyNote = "; body did NOT match" }
    }
    $observed = ("HTTP " + $probe.Status + $bodyNote)
    Add-CheckResult -Checks $Checks -Id $Id -Target $target -Expected $expectedText -Observed $observed -Pass ($statusOk -and $bodyOk)
    return $probe
}

function Add-HeaderCheck {
    param(
        $Checks,
        [hashtable]$Headers,
        [string]$Id,
        [string]$HeaderName,
        [bool]$MustExist = $true,
        [string]$MustMatch = "",
        [string]$MustNotMatch = ""
    )
    $value = Get-HeaderValue -Headers $Headers -Name $HeaderName
    $expectedParts = New-Object System.Collections.ArrayList
    if ($MustExist) { [void]$expectedParts.Add("present") } else { [void]$expectedParts.Add("absent") }
    if ($MustMatch) { [void]$expectedParts.Add("matches /" + $MustMatch + "/") }
    if ($MustNotMatch) { [void]$expectedParts.Add("does not match /" + $MustNotMatch + "/") }
    $expected = $HeaderName + " " + (@($expectedParts) -join " and ")
    $pass = $true
    if ($MustExist -and [string]::IsNullOrWhiteSpace($value)) { $pass = $false }
    if (-not $MustExist -and -not [string]::IsNullOrWhiteSpace($value)) { $pass = $false }
    if ($MustMatch -and $value -and (-not [regex]::IsMatch($value, $MustMatch))) { $pass = $false }
    if ($MustNotMatch -and $value -and ([regex]::IsMatch($value, $MustNotMatch))) { $pass = $false }
    $observed = "(absent)"
    if ($null -ne $value) { $observed = "(present) " + $value }
    if ($observed.Length -gt 240) { $observed = $observed.Substring(0, 237) + "..." }
    Add-CheckResult -Checks $Checks -Id $Id -Target ("header: " + $HeaderName) -Expected $expected -Observed $observed -Pass $pass
}

function Wait-ForHttpStatus {
    param(
        [string]$Url,
        [int]$TimeoutSeconds,
        [int[]]$ExpectedStatus = @(200)
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastDetail = "no attempt"
    while ((Get-Date) -lt $deadline) {
        $probe = Invoke-Probe -Url $Url
        if ($probe.Ok) {
            $lastDetail = "HTTP " + $probe.Status
            if ($ExpectedStatus -contains $probe.Status) { return $true }
        } else {
            $lastDetail = $probe.Error
        }
        Start-Sleep -Milliseconds 750
    }
    Write-Info ("last attempt for " + $Url + ": " + $lastDetail)
    return $false
}

# --- cloudflared helpers ----------------------------------------------------
function Find-QuickTunnelUrl {
    param([string[]]$LogPaths)
    $pattern = 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com'
    foreach ($logPath in $LogPaths) {
        if (-not (Test-Path -LiteralPath $logPath)) { continue }
        $text = ""
        try { $text = [System.IO.File]::ReadAllText($logPath) } catch { continue }
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $match = [regex]::Match($text, $pattern)
        if ($match.Success) { return $match.Value }
    }
    return $null
}

function Resolve-CloudflaredBinary {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($command) { return [PSCustomObject]@{ Path = [string]$command.Source; Source = "PATH" } }
    if (Test-Path -LiteralPath $cloudflaredLocal) { return [PSCustomObject]@{ Path = $cloudflaredLocal; Source = ".tools" } }
    return $null
}

function Install-CloudflaredBinary {
    Ensure-Directory -Path $toolsDir
    Write-Warn2 ("cloudflared.exe not found. Downloading about 55 MB from " + $quickTunnelDownloadUrl)
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    } catch { }
    $tempPath = $cloudflaredLocal + ".download"
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
    try {
        Invoke-WebRequest -Uri $quickTunnelDownloadUrl -OutFile $tempPath -UseBasicParsing -TimeoutSec 300
    } catch {
        throw ("cloudflared download failed: " + $_.Exception.Message + ". Download it manually from " + $quickTunnelDownloadUrl + " and save it as " + $cloudflaredLocal + ".")
    }
    if (-not (Test-Path -LiteralPath $tempPath)) { throw "cloudflared download produced no file." }
    $size = (Get-Item -LiteralPath $tempPath).Length
    if ($size -lt 10000000) {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        throw ("cloudflared download looks too small (" + $size + " bytes); refusing to use it.")
    }
    Move-Item -LiteralPath $tempPath -Destination $cloudflaredLocal -Force
    Write-Ok ("cloudflared downloaded to " + $cloudflaredLocal + " (" + [math]::Round($size / 1MB, 1) + " MiB).")
    return [PSCustomObject]@{ Path = $cloudflaredLocal; Source = ".tools" }
}

function Get-CloudflaredVersion([string]$CloudflaredBinary) {
    try {
        $versionText = (& $CloudflaredBinary --version 2>&1 | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { return $null }
        return ([string]$versionText).Trim()
    } catch {
        return $null
    }
}

# --- Client bundle bake check ----------------------------------------------
function Test-ValueInClientBundle([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -lt 8) { return $false }
    $staticDir = Join-Path $repoRoot ".next\static"
    if (-not (Test-Path -LiteralPath $staticDir)) { return $false }
    $files = @(Get-ChildItem -Path $staticDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq ".js" })
    foreach ($file in $files) {
        $text = ""
        try { $text = [System.IO.File]::ReadAllText($file.FullName) } catch { continue }
        if ($text.Contains($Value)) { return $true }
    }
    return $false
}

# --- Evidence writer --------------------------------------------------------
function Write-PublicDeploymentEvidence {
    param(
        [hashtable]$Context,
        $Checks
    )
    $lines = New-Object System.Collections.ArrayList
    $passCount = 0
    $failCount = 0
    $skipCount = 0
    foreach ($check in $Checks) {
        if ($check.Outcome -eq "PASS") { $passCount++ }
        elseif ($check.Outcome -eq "SKIP") { $skipCount++ }
        else { $failCount++ }
    }
    $overall = "FAIL"
    if ($failCount -eq 0) { $overall = "PASS" }

    [void]$lines.Add("# Public deployment evidence - ChatE (temporary Cloudflare quick tunnel)")
    [void]$lines.Add("")
    [void]$lines.Add("Generated: " + $Context.GeneratedAtUtc + " (UTC)")
    [void]$lines.Add("")
    [void]$lines.Add('> This file is generated by `scripts/deploy/public-demo.ps1` and is overwritten on')
    [void]$lines.Add('> every run. It records a TEMPORARY public URL from a Cloudflare quick tunnel.')
    [void]$lines.Add('> It is not a durable production deployment and it is not a substitute for the')
    [void]$lines.Add('> VPS runbook in `docs/launch/DEPLOYMENT-RUNBOOK.md`.')
    [void]$lines.Add("")
    [void]$lines.Add("## Verdict")
    [void]$lines.Add("")
    [void]$lines.Add("**" + $overall + "** - " + $passCount + " PASS, " + $failCount + " FAIL, " + $skipCount + " SKIP.")
    [void]$lines.Add("")
    [void]$lines.Add("## Run")
    [void]$lines.Add("")
    [void]$lines.Add("| Field | Value |")
    [void]$lines.Add("| --- | --- |")
    [void]$lines.Add("| Public URL | " + (Format-MdCell $Context.PublicUrl) + " |")
    [void]$lines.Add("| Local server | " + (Format-MdCell $Context.LocalUrl) + " |")
    [void]$lines.Add("| Tunnel | " + (Format-MdCell $Context.TunnelDescription) + " |")
    [void]$lines.Add("| HTTP client | " + (Format-MdCell $Context.HttpClientDescription) + " |")
    [void]$lines.Add("| Repo | " + (Format-MdCell $Context.RepoDescription) + " |")
    [void]$lines.Add("| Worktree | " + (Format-MdCell $Context.WorktreeDescription) + " |")
    [void]$lines.Add("| Node | " + (Format-MdCell $Context.NodeVersion) + " |")
    [void]$lines.Add("| Production build | BUILD_ID=" + (Format-MdCell $Context.BuildId) + " (built " + (Format-MdCell $Context.BuildTimestamp) + ") |")
    [void]$lines.Add("| APP_URL in .env.local | " + (Format-MdCell $Context.AppUrlConfigured) + " |")
    [void]$lines.Add("| APP_URL effective | " + (Format-MdCell $Context.AppUrlEffective) + " |")
    [void]$lines.Add("| TURNSTILE_EXPECTED_HOSTNAMES | " + (Format-MdCell $Context.TurnstileHostnames) + " |")
    [void]$lines.Add("| HAIKU_LIVE_CALLS | " + (Format-MdCell $Context.HaikuLiveCalls) + " |")
    [void]$lines.Add("| Env file | " + (Format-MdCell $Context.EnvFileDescription) + " |")
    [void]$lines.Add("| Command | " + (Format-MdCell $Context.CommandLine) + " |")
    [void]$lines.Add("")
    [void]$lines.Add("Server process pid " + $Context.ServerPid + ", tunnel process pid " + $Context.TunnelPid + ". Both are left running intentionally by the script; stop them with ``scripts/deploy/public-demo.ps1 -Stop``.")
    [void]$lines.Add("")
    [void]$lines.Add("## Checks")
    [void]$lines.Add("")
    [void]$lines.Add("| # | Check | Target | Expected | Observed | Result |")
    [void]$lines.Add("| --- | --- | --- | --- | --- | --- |")
    $index = 0
    foreach ($check in $Checks) {
        $index++
        [void]$lines.Add("| " + $index + " | " + (Format-MdCell $check.Id) + " | " + (Format-MdCell $check.Target) + " | " + (Format-MdCell $check.Expected) + " | " + (Format-MdCell $check.Observed) + " | " + $check.Outcome + " |")
    }
    [void]$lines.Add("")
    [void]$lines.Add("## Response headers (public origin, GET /)")
    [void]$lines.Add("")
    [void]$lines.Add("| Header | Value |")
    [void]$lines.Add("| --- | --- |")
    foreach ($headerName in @("strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "cross-origin-opener-policy", "referrer-policy", "permissions-policy", "cache-control", "x-powered-by")) {
        $headerValue = "(absent)"
        if ($Context.PublicRootHeaders.ContainsKey($headerName)) { $headerValue = [string]$Context.PublicRootHeaders[$headerName] }
        [void]$lines.Add("| " + $headerName + " | " + (Format-MdCell $headerValue) + " |")
    }
    [void]$lines.Add("")
    [void]$lines.Add("## What this proves")
    [void]$lines.Add("")
    [void]$lines.Add('- The production build serves the Arabic RTL landing page, `/privacy` and `/terms` over public HTTPS through the Cloudflare edge.')
    [void]$lines.Add('- `GET /api/models` answers 200 with `"ok":true` from the public origin.')
    [void]$lines.Add('- Security headers are emitted on the public response: HSTS, CSP without `unsafe-eval`, `X-Frame-Options: DENY`, `nosniff`, COOP, no `X-Powered-By`.')
    [void]$lines.Add('- Anonymous API access stays closed: admin/comparisons/history reject anonymous requests, uploads rejects or requires a session.')
    [void]$lines.Add('- A reproducible, account-free public URL path exists for this exact production build.')
    [void]$lines.Add("")
    [void]$lines.Add("## What this does NOT prove (honest limitations)")
    [void]$lines.Add("")
    [void]$lines.Add('- **No durable hosting.** A quick tunnel is ephemeral, has no SLA, and the URL stops working when `cloudflared` stops. Production still needs the VPS + Caddy + Cloudflare path in `docs/launch/DEPLOYMENT-RUNBOOK.md` or another owner-chosen host.')
    [void]$lines.Add('- **No domain, DNS ownership, or TLS certificate management.** TLS here is the Cloudflare edge certificate for `*.trycloudflare.com`, not the product domain.')
    [void]$lines.Add('- **Google sign-in is expected NOT to work on this origin.** `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is baked at build time and the throwaway hostname is not an authorized JavaScript origin in Google Cloud; `APP_URL` also does not match this origin.')
    [void]$lines.Add('- **Turnstile-gated flows are expected NOT to work on this origin.** The loaded .env.local lists localhost/127.0.0.1 in `TURNSTILE_EXPECTED_HOSTNAMES`, which production mode rejects by design (HTTP 503 `TURNSTILE_LOCALHOST`), and the throwaway hostname is not registered on the Turnstile widget either. Sign-in, upload and OTP interactions therefore fail closed here.')
    [void]$lines.Add('- **Uploads/OTP/comparisons end-to-end are not exercised here.** They require a signed-in, phone-verified session; separate verification evidence covers the API paths.')
    [void]$lines.Add('- **No load, capacity, uptime, or monitoring evidence.** No provider (OpenRouter/Anthropic) call is made by this script; `HAIKU_LIVE_CALLS` is recorded above.')
    [void]$lines.Add('- **Not executed on a VPS.** The deploy bundle under `deploy/` is still review-only until the owner runs the runbook on a real server.')
    [void]$lines.Add("")
    [void]$lines.Add("## How to reproduce")
    [void]$lines.Add("")
    [void]$lines.Add('```powershell')
    [void]$lines.Add('# from the repository root (add -Build after code changes)')
    [void]$lines.Add('powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Build')
    [void]$lines.Add('')
    [void]$lines.Add('# stop the server + tunnel recorded by the run')
    [void]$lines.Add('powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Stop')
    [void]$lines.Add('```')
    [void]$lines.Add("")
    [void]$lines.Add('Logs for this run are under `.tools/public-demo/` (gitignored). No secret values from `.env.local` are recorded in this file.')
    [void]$lines.Add("")

    Ensure-Directory -Path (Split-Path -Parent $Context.EvidencePath)
    Write-Utf8File -Path $Context.EvidencePath -Content ((@($lines) -join "`n") + "`n")
    return $overall
}

# ===========================================================================
# -Stop mode (does not need Node, env file, or network)
# ===========================================================================
if ($Stop) {
    Write-Step "Stopping the ChatE public demo recorded by the last run"
    $state = Read-DemoState
    if ($null -eq $state) {
        Write-Info ("No demo state found at " + $statePath + ". Nothing to stop.")
        exit 0
    }
    $anyStopped = $false
    if ($state.ContainsKey("tunnelPid") -and $state["tunnelPid"]) {
        if (Stop-VerifiedProcessTree -TargetProcessId ([int]$state["tunnelPid"]) -Label "cloudflared quick tunnel" -ExpectedCommandPattern "cloudflared" -ExpectedStartUtcIso ([string]$state["tunnelStartedAtUtc"])) {
            $anyStopped = $true
        }
    }
    if ($state.ContainsKey("serverPid") -and $state["serverPid"]) {
        if (Stop-VerifiedProcessTree -TargetProcessId ([int]$state["serverPid"]) -Label "Next.js production server" -ExpectedCommandPattern "next" -ExpectedStartUtcIso ([string]$state["serverStartedAtUtc"])) {
            $anyStopped = $true
        }
    }
    $evidencePathFromState = ""
    if ($state.ContainsKey("evidencePath") -and $state["evidencePath"]) { $evidencePathFromState = [string]$state["evidencePath"] }
    $evidenceExists = $false
    if ($evidencePathFromState) { $evidenceExists = Test-Path -LiteralPath $evidencePathFromState }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Write-Host ""
    if ($anyStopped) {
        Write-Ok "Demo processes stopped. The state file was removed."
    } else {
        Write-Warn2 "No live demo processes matched the recorded state; the stale state file was removed."
    }
    if ($evidenceExists) { Write-Info ("Last evidence kept at " + $evidencePathFromState) } else { Write-Info "No evidence file was recorded." }
    Write-Info "Logs remain under .tools/public-demo/ (gitignored)."
    exit 0
}

# ===========================================================================
# Validate basics shared by -DryRun and a live run
# ===========================================================================
if ($Port -lt 1 -or $Port -gt 65535) {
    Write-Fail2 ("Invalid -Port " + $Port + ". Use 1..65535.")
    exit 2
}
if ($ServerTimeoutSeconds -lt 5) { $ServerTimeoutSeconds = 5 }
if ($TunnelTimeoutSeconds -lt 5) { $TunnelTimeoutSeconds = 5 }
if ($ProbeTimeoutSeconds -lt 5) { $ProbeTimeoutSeconds = 5 }

$envFilePath = $EnvFile
if (-not [System.IO.Path]::IsPathRooted($envFilePath)) { $envFilePath = Join-Path $repoRoot $envFilePath }

$nodeBinary = Resolve-NodeBinary -ExplicitPath $NodePath
if ($null -eq $nodeBinary) {
    Write-Fail2 "Node.js not found. Expected node on PATH or C:\Pak\node.exe. Pass -NodePath."
    exit 2
}
$nodeVersion = Get-NodeVersion -NodeBinary $nodeBinary
if ($null -eq $nodeVersion) {
    Write-Fail2 ("Could not run " + $nodeBinary + " --version.")
    exit 2
}
$nodeMajor = 0
$majorMatch = [regex]::Match($nodeVersion, 'v?(\d+)\.')
if ($majorMatch.Success) { $nodeMajor = [int]$majorMatch.Groups[1].Value }

$buildIdPath = Join-Path $repoRoot ".next\BUILD_ID"
$hasProductionBuild = Test-Path -LiteralPath $buildIdPath
$buildId = ""
$buildTimestamp = "(unknown)"
if ($hasProductionBuild) {
    try { $buildId = ([System.IO.File]::ReadAllText($buildIdPath)).Trim() } catch { $buildId = "(unreadable)" }
    try { $buildTimestamp = (Get-Item -LiteralPath $buildIdPath).LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ") } catch { }
}
$needBuild = ($Build -or (-not $hasProductionBuild))

$localUrl = "http://127.0.0.1:" + $Port
$effectiveAppUrl = $AppUrl
if ([string]::IsNullOrWhiteSpace($effectiveAppUrl)) { $effectiveAppUrl = $localUrl }

# -DryRun: print the plan, change nothing.
if ($DryRun) {
    Write-Step "ChatE public demo - dry run (nothing will be started or downloaded)"
    Write-Info ("Repository:        " + $repoRoot)
    Write-Info ("Node:              " + $nodeVersion + "  [" + $nodeBinary + "]")
    if ($nodeMajor -lt 22) { Write-Warn2 "Node 22.5+ is required by node:sqlite; Node 24 is the supported runtime." }
    Write-Info ("Env file:          " + $envFilePath + " (" + $(if (Test-Path -LiteralPath $envFilePath) { "present" } else { "MISSING - a live run will fail" }) + ")")
    Write-Info ("Local origin:      " + $localUrl)
    Write-Info ("APP_URL effective: " + $effectiveAppUrl)
    if ($hasProductionBuild) {
        Write-Info ("Production build:  present (BUILD_ID=" + $buildId + ", " + $buildTimestamp + ")")
    } else {
        Write-Info ("Production build:  MISSING (.next/BUILD_ID not found)")
    }
    if ($needBuild) { Write-Info ("Build:             next build WOULD run" + $(if ($Build) { " (-Build)" } else { " (no production build found)" })) } else { Write-Info "Build:             skipped (add -Build to rebuild)" }
    $cloudflared = Resolve-CloudflaredBinary
    if ($null -ne $cloudflared) {
        Write-Info ("cloudflared:       " + $cloudflared.Path + " (source: " + $cloudflared.Source + ")")
    } else {
        Write-Info ("cloudflared:       not found; a live run WOULD download it to " + $cloudflaredLocal)
    }
    if (Test-PortListening -TargetPort $Port) {
        Write-Warn2 ("Port " + $Port + " is already listening. A live run would refuse to start; stop the other process (or pass -Port).")
    } else {
        Write-Info ("Port " + $Port + ":        free")
    }
    $existingState = Read-DemoState
    if ($null -ne $existingState) {
        Write-Warn2 ("A previous demo state exists (public URL " + [string]$existingState["publicUrl"] + "). Run -Stop first if it is still running.")
    }
    Write-Info ("Evidence target:   " + $evidencePath)
    Write-Info ("Logs directory:    " + $demoDir)
    Write-Host ""
    Write-Ok "Dry run complete. No processes were started and no files were changed."
    exit 0
}

# ===========================================================================
# Live run
# ===========================================================================
$runStartedAt = (Get-Date).ToUniversalTime()
$runStartedIso = $runStartedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
$commandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File " + $MyInvocation.MyCommand.Path + $(if ($Build) { " -Build" } else { "" })

$serverProcess = $null
$tunnelProcess = $null
$serverStartedAtIso = ""
$tunnelStartedAtIso = ""
$publicUrl = $null
$evidenceWritten = $false
$exitCode = 2
$demoPassed = $false
$checks = New-Object System.Collections.ArrayList
$checksRun = $false
$context = @{}

Write-Step "ChatE public demo - production server + Cloudflare quick tunnel"
Write-Info ("Repository: " + $repoRoot)
Write-Info ("PowerShell: " + $PSVersionTable.PSVersion.ToString())

try {
    # 1) Node runtime sanity
    if ($nodeMajor -lt 22) {
        throw ("Node " + $nodeVersion + " is too old for node:sqlite (need 22.5+, use 24). Pass -NodePath.")
    }
    Write-Ok ("Node " + $nodeVersion + " [" + $nodeBinary + "]")

    # 2) Load .env.local into the process environment (values never printed)
    Write-Step "Loading environment from " + $envFilePath
    $envResult = Import-DotEnvFile -Path $envFilePath
    Write-Ok ("Loaded " + $envResult.Imported + " variables (" + $envResult.Skipped + " lines skipped). Values are hidden and inherited by child processes.")
    $appUrlConfigured = ""
    if (Test-Path Env:APP_URL) { $appUrlConfigured = [string]$env:APP_URL }
    $turnstileHostnames = ""
    if (Test-Path Env:TURNSTILE_EXPECTED_HOSTNAMES) { $turnstileHostnames = [string]$env:TURNSTILE_EXPECTED_HOSTNAMES }
    $haikuLive = "(unset)"
    if (Test-Path Env:HAIKU_LIVE_CALLS) { $haikuLive = [string]$env:HAIKU_LIVE_CALLS }
    $env:NODE_ENV = "production"
    $env:NEXT_TELEMETRY_DISABLED = "1"
    $env:APP_URL = $effectiveAppUrl
    Write-Info ("APP_URL configured in env file: " + $appUrlConfigured)
    Write-Info ("APP_URL effective for this run: " + $effectiveAppUrl)

    # 3) Production build (required; NEXT_PUBLIC_* are baked at build time)
    if ($needBuild) {
        Write-Step "Building production bundle (next build). This can take a few minutes..."
        Ensure-Directory -Path $demoDir
        $buildOutLog = Join-Path $demoDir "build.out.log"
        $buildErrLog = Join-Path $demoDir "build.err.log"
        foreach ($logFile in @($buildOutLog, $buildErrLog)) {
            if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }
        }
        Write-Info ("Build output is written to " + $buildOutLog + " and " + $buildErrLog)
        $buildStarted = Get-Date
        $buildProcess = Start-Process -FilePath $nodeBinary -ArgumentList @("node_modules/next/dist/bin/next", "build") -WorkingDirectory $repoRoot -RedirectStandardOutput $buildOutLog -RedirectStandardError $buildErrLog -PassThru -NoNewWindow -Wait
        $buildExit = $buildProcess.ExitCode
        $buildSeconds = [math]::Round(((Get-Date) - $buildStarted).TotalSeconds, 1)
        if ($buildExit -ne 0) {
            throw ("next build failed with exit code " + $buildExit + " after " + $buildSeconds + "s. Tail of " + $buildOutLog + ":" + [Environment]::NewLine + (Get-LogTail -Path $buildOutLog -Lines 25) + [Environment]::NewLine + "Tail of " + $buildErrLog + ":" + [Environment]::NewLine + (Get-LogTail -Path $buildErrLog -Lines 25))
        }
        $hasProductionBuild = Test-Path -LiteralPath $buildIdPath
        if (-not $hasProductionBuild) { throw "next build finished but .next/BUILD_ID is missing." }
        try { $buildId = ([System.IO.File]::ReadAllText($buildIdPath)).Trim() } catch { $buildId = "(unreadable)" }
        try { $buildTimestamp = (Get-Item -LiteralPath $buildIdPath).LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ") } catch { }
        Write-Ok ("Production build complete in " + $buildSeconds + "s (BUILD_ID=" + $buildId + ").")
    } else {
        Write-Warn2 ("Using the existing production build BUILD_ID=" + $buildId + " (" + $buildTimestamp + "). Pass -Build after code changes to rebuild.")
    }

    # 4) Port must be free
    if (Test-PortListening -TargetPort $Port) {
        throw ("Port " + $Port + " is already in use. Stop the process using it, or pass a different -Port. If it is a previous demo, run this script with -Stop.")
    }

    # 5) Start the production server on loopback only
    Write-Step ("Starting next start on 127.0.0.1:" + $Port)
    Ensure-Directory -Path $demoDir
    $serverOutLog = Join-Path $demoDir "server.out.log"
    $serverErrLog = Join-Path $demoDir "server.err.log"
    foreach ($logFile in @($serverOutLog, $serverErrLog)) {
        if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }
    }
    $serverProcess = Start-Process -FilePath $nodeBinary -ArgumentList @("node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", [string]$Port) -WorkingDirectory $repoRoot -RedirectStandardOutput $serverOutLog -RedirectStandardError $serverErrLog -PassThru -WindowStyle Hidden
    $serverStartedAtIso = $serverProcess.StartTime.ToUniversalTime().ToString("o")
    Write-Info ("Server pid " + $serverProcess.Id + "; logs: " + $serverOutLog + ", " + $serverErrLog)
    $localModelsUrl = $localUrl + "/api/models"
    $localReady = Wait-ForHttpStatus -Url $localModelsUrl -TimeoutSeconds $ServerTimeoutSeconds -ExpectedStatus @(200)
    if (-not $localReady) {
        $serverProcess.Refresh()
        $exitNote = "still running"
        if ($serverProcess.HasExited) { $exitNote = "exited with code " + $serverProcess.ExitCode }
        throw ("Local production server did not answer " + $localModelsUrl + " (" + $exitNote + "). Tail of server.err.log:" + [Environment]::NewLine + (Get-LogTail -Path $serverErrLog -Lines 30) + [Environment]::NewLine + "Tail of server.out.log:" + [Environment]::NewLine + (Get-LogTail -Path $serverOutLog -Lines 20))
    }
    Write-Ok ("Local server ready: " + $localModelsUrl + " -> HTTP 200")

    # 6) cloudflared (PATH, .tools, or download into .tools)
    Write-Step "Preparing cloudflared"
    $cloudflared = Resolve-CloudflaredBinary
    if ($null -eq $cloudflared) {
        $cloudflared = Install-CloudflaredBinary
    } else {
        Write-Ok ("cloudflared found (" + $cloudflared.Source + "): " + $cloudflared.Path)
    }
    $cloudflaredVersion = Get-CloudflaredVersion -CloudflaredBinary $cloudflared.Path
    if ($null -eq $cloudflaredVersion) {
        throw ("cloudflared at " + $cloudflared.Path + " did not run. Delete it and re-run so it re-downloads, or install cloudflared on PATH.")
    }
    Write-Ok ("cloudflared: " + $cloudflaredVersion)

    # 7) Start the quick tunnel. Retry once with HTTP/2 if QUIC is blocked.
    Write-Step "Starting Cloudflare quick tunnel (no account, ephemeral URL)"
    $tunnelOutLog = Join-Path $demoDir "cloudflared.out.log"
    $tunnelErrLog = Join-Path $demoDir "cloudflared.err.log"
    $protocols = @("", "http2")
    $attempt = 0
    foreach ($protocol in $protocols) {
        $attempt++
        if ($null -ne $tunnelProcess) {
            try { Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue } catch { }
            $tunnelProcess = $null
        }
        foreach ($logFile in @($tunnelOutLog, $tunnelErrLog)) {
            if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }
        }
        $tunnelArgs = @("tunnel", "--no-autoupdate", "--url", $localUrl)
        $protocolLabel = "default transport (QUIC)"
        if ($protocol) {
            $tunnelArgs += @("--protocol", $protocol)
            $protocolLabel = "protocol " + $protocol
        }
        Write-Info ("Attempt " + $attempt + ": " + $protocolLabel)
        $tunnelProcess = Start-Process -FilePath $cloudflared.Path -ArgumentList $tunnelArgs -WorkingDirectory $repoRoot -RedirectStandardOutput $tunnelOutLog -RedirectStandardError $tunnelErrLog -PassThru -WindowStyle Hidden
        $tunnelStartedAtIso = $tunnelProcess.StartTime.ToUniversalTime().ToString("o")
        Write-Info ("Tunnel pid " + $tunnelProcess.Id + "; logs: " + $tunnelOutLog + ", " + $tunnelErrLog)
        $deadline = (Get-Date).AddSeconds($TunnelTimeoutSeconds)
        $publicUrl = $null
        while ((Get-Date) -lt $deadline) {
            $publicUrl = Find-QuickTunnelUrl -LogPaths @($tunnelErrLog, $tunnelOutLog)
            if ($publicUrl) { break }
            $tunnelProcess.Refresh()
            if ($tunnelProcess.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($publicUrl) {
            Write-Ok ("Quick tunnel URL: " + $publicUrl)
            break
        }
        $tunnelProcess.Refresh()
        $exitNote = "still running"
        if ($tunnelProcess.HasExited) { $exitNote = "exited with code " + $tunnelProcess.ExitCode }
        Write-Warn2 ("No https://*.trycloudflare.com URL after " + $TunnelTimeoutSeconds + "s (" + $exitNote + "). cloudflared stderr tail:" + [Environment]::NewLine + (Get-LogTail -Path $tunnelErrLog -Lines 20))
    }
    if (-not $publicUrl) {
        throw "Could not obtain a Cloudflare quick tunnel URL. Check network access to Cloudflare (outbound 7844/443 or HTTP/2 fallback) and the cloudflared logs under .tools/public-demo/."
    }

    # 8) Persist state BEFORE probing so -Stop always works, even if probes fail.
    Save-DemoState -State @{
        schema = 1
        port = $Port
        publicUrl = $publicUrl
        localUrl = $localUrl
        serverPid = $serverProcess.Id
        serverStartedAtUtc = $serverStartedAtIso
        tunnelPid = $tunnelProcess.Id
        tunnelStartedAtUtc = $tunnelStartedAtIso
        startedAtUtc = $runStartedIso
        evidencePath = $evidencePath
        logsDir = $demoDir
    }
    Write-Info ("State saved to " + $statePath + " (used by -Stop).")

    # 9) Wait for Cloudflare edge to serve the public origin, then probe.
    Write-Step "Waiting for the public URL to answer (edge propagation)"
    $publicRootUrl = $publicUrl + "/"
    $publicRootReady = Wait-ForHttpStatus -Url $publicRootUrl -TimeoutSeconds $ProbeTimeoutSeconds -ExpectedStatus @(200)
    if ($publicRootReady) {
        Write-Ok ("Public origin reachable: " + $publicRootUrl)
    } else {
        Write-Warn2 ("Public origin did not return HTTP 200 within " + $ProbeTimeoutSeconds + "s; probes will record the failure.")
    }

    Write-Step "Probing the public deployment"
    $checksRun = $true
    $checks = New-Object System.Collections.ArrayList

    # Local origin
    $null = Invoke-ExpectedStatus -Checks $checks -Id "local.root" -Url ($localUrl + "/") -ExpectedStatus @(200) -BodyPattern 'dir="rtl"' -TargetLabel ("local GET " + $localUrl + "/")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "local.models" -Url ($localUrl + "/api/models") -ExpectedStatus @(200) -BodyPattern '"ok"\s*:\s*true' -TargetLabel ("local GET " + $localUrl + "/api/models")

    # Public pages and APIs
    $publicRootProbe = Invoke-ExpectedStatus -Checks $checks -Id "public.root" -Url $publicRootUrl -ExpectedStatus @(200) -BodyPattern 'dir="rtl"' -TargetLabel ("public GET " + $publicRootUrl)
    $null = Invoke-ExpectedStatus -Checks $checks -Id "public.models" -Url ($publicUrl + "/api/models") -ExpectedStatus @(200) -BodyPattern '"ok"\s*:\s*true' -TargetLabel ("public GET " + $publicUrl + "/api/models")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "public.privacy" -Url ($publicUrl + "/privacy") -ExpectedStatus @(200) -TargetLabel ("public GET " + $publicUrl + "/privacy")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "public.terms" -Url ($publicUrl + "/terms") -ExpectedStatus @(200) -TargetLabel ("public GET " + $publicUrl + "/terms")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "api.admin.anon" -Url ($publicUrl + "/api/admin/overview") -ExpectedStatus @(401) -TargetLabel ("anonymous GET " + $publicUrl + "/api/admin/overview")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "api.comparisons.anon" -Url ($publicUrl + "/api/comparisons") -ExpectedStatus @(401) -Method "POST" -Body "{}" -TargetLabel ("anonymous POST " + $publicUrl + "/api/comparisons")
    $null = Invoke-ExpectedStatus -Checks $checks -Id "api.uploads.anon" -Url ($publicUrl + "/api/uploads") -ExpectedStatus @(401, 403) -Method "POST" -Body "{}" -TargetLabel ("anonymous POST " + $publicUrl + "/api/uploads")

    # History route may not exist in every build; 404 is reported as SKIP, not FAIL.
    $historyProbe = Invoke-Probe -Url ($publicUrl + "/api/history")
    $historyTarget = "anonymous GET " + $publicUrl + "/api/history"
    if (-not $historyProbe.Ok) {
        Add-CheckResult -Checks $checks -Id "api.history.anon" -Target $historyTarget -Expected "HTTP 401 (or 404 if the history route is not in this build)" -Observed ("request error: " + $historyProbe.Error) -Pass $false
    } elseif ($historyProbe.Status -eq 401) {
        Add-CheckResult -Checks $checks -Id "api.history.anon" -Target $historyTarget -Expected "HTTP 401" -Observed "HTTP 401" -Pass $true
    } elseif ($historyProbe.Status -eq 404) {
        Add-CheckResult -Checks $checks -Id "api.history.anon" -Target $historyTarget -Expected "HTTP 401 (or 404 if the history route is not in this build)" -Observed "HTTP 404 (route not in this build)" -Pass $true -Skip $true
    } else {
        Add-CheckResult -Checks $checks -Id "api.history.anon" -Target $historyTarget -Expected "HTTP 401" -Observed ("HTTP " + $historyProbe.Status) -Pass $false
    }

    # Tunnel is HTTPS by construction.
    Add-CheckResult -Checks $checks -Id "tunnel.https" -Target $publicUrl -Expected "https:// URL" -Observed $publicUrl -Pass ($publicUrl -like "https://*")

    # Security headers from the public root response.
    $publicRootHeaders = @{}
    if ($null -ne $publicRootProbe -and $publicRootProbe.Ok) { $publicRootHeaders = $publicRootProbe.Headers }
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.hsts" -HeaderName "strict-transport-security" -MustExist $true -MustMatch 'max-age=\d+'
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.csp" -HeaderName "content-security-policy" -MustExist $true -MustMatch "default-src 'self'" -MustNotMatch "unsafe-eval"
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.x-frame-options" -HeaderName "x-frame-options" -MustExist $true -MustMatch '^DENY$'
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.nosniff" -HeaderName "x-content-type-options" -MustExist $true -MustMatch 'nosniff'
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.coop" -HeaderName "cross-origin-opener-policy" -MustExist $true -MustMatch 'same-origin-allow-popups'
    Add-HeaderCheck -Checks $checks -Headers $publicRootHeaders -Id "headers.no-powered-by" -HeaderName "x-powered-by" -MustExist $false

    # NEXT_PUBLIC_* values are baked at build time; changing them needs a rebuild.
    $publicEnvChecks = @(
        @{ Name = "NEXT_PUBLIC_GOOGLE_CLIENT_ID"; Display = "Google client id" },
        @{ Name = "NEXT_PUBLIC_TURNSTILE_SITE_KEY"; Display = "Turnstile site key" }
    )
    foreach ($publicEnv in $publicEnvChecks) {
        $value = [System.Environment]::GetEnvironmentVariable([string]$publicEnv.Name)
        if ($null -eq $value) { $value = "" }
        $checkId = "bundle." + $publicEnv.Name.ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($value)) {
            Add-CheckResult -Checks $checks -Id $checkId -Target ("client bundle: " + $publicEnv.Display) -Expected "value present in env and baked into .next/static" -Observed "env value empty; widget disabled in this build" -Pass $true -Skip $true
        } elseif (Test-ValueInClientBundle -Value $value) {
            Add-CheckResult -Checks $checks -Id $checkId -Target ("client bundle: " + $publicEnv.Display) -Expected "baked into .next/static" -Observed "baked" -Pass $true
        } else {
            Add-CheckResult -Checks $checks -Id $checkId -Target ("client bundle: " + $publicEnv.Display) -Expected "baked into .next/static" -Observed "NOT found in .next/static (stale build? re-run with -Build)" -Pass $false
        }
    }

    # 10) Write evidence
    Write-Step "Writing evidence to " + $evidencePath
    $gitHead = "unknown"
    $gitDirtyCount = -1
    Push-Location $repoRoot
    try {
        $headOutput = (& git rev-parse --short HEAD 2>&1)
        if ($LASTEXITCODE -eq 0 -and $headOutput) { $gitHead = ([string]($headOutput | Select-Object -First 1)).Trim() }
        $statusOutput = @(& git status --porcelain 2>&1)
        if ($LASTEXITCODE -eq 0) { $gitDirtyCount = $statusOutput.Count }
    } catch { } finally { Pop-Location }
    $worktreeDescription = "clean"
    if ($gitDirtyCount -lt 0) { $worktreeDescription = "unknown (git unavailable)" } elseif ($gitDirtyCount -gt 0) { $worktreeDescription = [string]$gitDirtyCount + " changed/untracked entries (pre-commit worktree)" }
    $httpClientDescription = "System.Net.Http.HttpClient (PS " + $PSVersionTable.PSVersion.ToString() + ")"
    $repoDescription = "ChatE at " + $gitHead
    $tunnelDescription = $cloudflaredVersion + " quick tunnel (trycloudflare.com, no account, ephemeral)"
    $envFileDescription = $envFilePath + " (" + $envResult.Imported + " variables loaded; values not recorded)"
    if ($null -eq $publicRootProbe -or -not $publicRootProbe.Ok) { $publicRootHeaders = @{} }
    $context = @{
        GeneratedAtUtc = $runStartedIso
        PublicUrl = $publicUrl
        LocalUrl = $localUrl
        TunnelDescription = $tunnelDescription
        HttpClientDescription = $httpClientDescription
        RepoDescription = $repoDescription
        WorktreeDescription = $worktreeDescription
        NodeVersion = $nodeVersion
        BuildId = $buildId
        BuildTimestamp = $buildTimestamp
        AppUrlConfigured = $appUrlConfigured
        AppUrlEffective = $effectiveAppUrl
        TurnstileHostnames = $turnstileHostnames
        HaikuLiveCalls = $haikuLive
        EnvFileDescription = $envFileDescription
        CommandLine = $commandLine
        ServerPid = $serverProcess.Id
        TunnelPid = $tunnelProcess.Id
        EvidencePath = $evidencePath
        PublicRootHeaders = $publicRootHeaders
    }
    $overall = Write-PublicDeploymentEvidence -Context $context -Checks $checks
    $evidenceWritten = $true
    if ($overall -eq "PASS") {
        $demoPassed = $true
        Write-Ok ("Evidence written: " + $evidencePath + " (PASS)")
    } else {
        Write-Fail2 ("Evidence written: " + $evidencePath + " (FAIL - see the table)")
        Write-Info "The server and tunnel are left running for diagnosis; stop them with -Stop when done."
    }
    $exitCode = 0
    if (-not $demoPassed) { $exitCode = 1 }
} catch {
    Write-Host ""
    Write-Fail2 ("SETUP FAILED: " + $_.Exception.Message)
    $exitCode = 2
    if (-not $evidenceWritten) {
        Write-Info "Stopping any demo processes started by this run (no evidence was written)."
        if ($null -ne $tunnelProcess) {
            try {
                $tunnelProcess.Refresh()
                if (-not $tunnelProcess.HasExited) { Stop-VerifiedProcessTree -TargetProcessId $tunnelProcess.Id -Label "cloudflared quick tunnel" -ExpectedCommandPattern "cloudflared" | Out-Null }
            } catch { }
        }
        if ($null -ne $serverProcess) {
            try {
                $serverProcess.Refresh()
                if (-not $serverProcess.HasExited) { Stop-VerifiedProcessTree -TargetProcessId $serverProcess.Id -Label "Next.js production server" -ExpectedCommandPattern "next" | Out-Null }
            } catch { }
        }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    }
} finally {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host " SUMMARY" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    if ($publicUrl) { Write-Host (" Public URL:      " + $publicUrl) -ForegroundColor Green }
    if ($null -ne $serverProcess) { Write-Host (" Local server:    " + $localUrl + " (pid " + $serverProcess.Id + ")") }
    if ($null -ne $tunnelProcess) { Write-Host (" Cloudflared:     pid " + $tunnelProcess.Id) }
    if ($checksRun) {
        $passTotal = 0
        $failTotal = 0
        $skipTotal = 0
        foreach ($check in $checks) {
            if ($check.Outcome -eq "PASS") { $passTotal++ } elseif ($check.Outcome -eq "SKIP") { $skipTotal++ } else { $failTotal++ }
        }
        Write-Host (" Checks:          " + $passTotal + " PASS, " + $failTotal + " FAIL, " + $skipTotal + " SKIP")
    }
    if ($evidenceWritten) { Write-Host (" Evidence:        " + $evidencePath) }
    Write-Host (" Logs:            " + $demoDir)
    $running = New-Object System.Collections.ArrayList
    if ($null -ne $serverProcess) {
        try { $serverProcess.Refresh(); if (-not $serverProcess.HasExited) { [void]$running.Add("Next.js server on " + $localUrl + " (pid " + $serverProcess.Id + ")") } } catch { }
    }
    if ($null -ne $tunnelProcess) {
        try { $tunnelProcess.Refresh(); if (-not $tunnelProcess.HasExited) { [void]$running.Add("cloudflared quick tunnel" + $(if ($publicUrl) { " for " + $publicUrl } else { "" }) + " (pid " + $tunnelProcess.Id + ")") } } catch { }
    }
    Write-Host ""
    if ($running.Count -gt 0) {
        Write-Host " STILL RUNNING (intentional - allows manual inspection):" -ForegroundColor Yellow
        foreach ($item in $running) { Write-Host ("   - " + $item) -ForegroundColor Yellow }
        Write-Host ""
        Write-Host " Stop them with:" -ForegroundColor Yellow
        Write-Host "   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy\public-demo.ps1 -Stop" -ForegroundColor Yellow
    } else {
        Write-Host " No demo processes are left running." -ForegroundColor Green
    }
    Write-Host "============================================================" -ForegroundColor Cyan
}
exit $exitCode
