# PocketClaw — Service Status
#
# Shows current service state, recent logs, mnemon health, and last
# ingestion result. Read-only — runs even without admin.
#
# Usage (from repo root):
#   .\scripts\service\status.ps1
#   .\scripts\service\status.ps1 -Tail 100   # show last 100 log lines
#   .\scripts\service\status.ps1 -Follow     # tail logs in real time

[CmdletBinding()]
param(
    [string]$Name = "pocketclaw",
    [int]$Tail = 30,
    [switch]$Follow
)

$ErrorActionPreference = "Continue"
function Heading($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Kv($k, $v)    { Write-Host ("  {0,-18} {1}" -f $k, $v) }

# --- service ----
Heading "Service"
$svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($svc) {
    Kv "Name"       $svc.Name
    Kv "DisplayName" $svc.DisplayName
    Kv "Status"     $svc.Status
    Kv "StartType"  $svc.StartType
    if ($svc.Status -eq "Running") {
        $proc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessId -gt 0) {
            $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($p) {
                Kv "PID"       $p.Id
                Kv "Memory"    "$([Math]::Round($p.WorkingSet64/1MB, 1)) MB"
                Kv "CPU(s)"    "$([Math]::Round($p.CPU, 1))"
                Kv "Started"   $p.StartTime
            }
        }
    }
} else {
    Kv "Name"   $Name
    Kv "Status" "NOT INSTALLED"
}

# --- mnemon ----
Heading "mnemon"
$mnemonExe = (Get-Command mnemon -ErrorAction SilentlyContinue).Source
if ($mnemonExe) {
    Kv "CLI"     $mnemonExe
    try {
        $st = mnemon status 2>&1 | ConvertFrom-Json
        Kv "DB"            $st.db_path
        Kv "Insights"      "$($st.total_insights) (deleted $($st.deleted_insights))"
        Kv "Edges"         $st.edge_count
        Kv "DB size"       "$([Math]::Round($st.db_size_bytes / 1KB, 1)) KB"
        $top = ($st.top_entities | Select-Object -First 5 | ForEach-Object { $_.entity }) -join ", "
        Kv "Top entities"  $top
    } catch {
        Kv "Status" "ERROR: $($_.Exception.Message)"
    }
} else {
    Kv "Status" "mnemon CLI not on PATH"
}

# --- logs ----
$logDir = Join-Path $env:USERPROFILE ".pocketclaw\logs"
$stdout = Join-Path $logDir "service.stdout.log"
$stderr = Join-Path $logDir "service.stderr.log"
$audit  = Join-Path $logDir "audit.log"

Heading "Logs"
foreach ($f in @($stdout, $stderr, $audit)) {
    if (Test-Path $f) {
        $size = [Math]::Round((Get-Item $f).Length / 1KB, 1)
        $when = (Get-Item $f).LastWriteTime
        Kv (Split-Path $f -Leaf) "$size KB (modified $when)"
    } else {
        Kv (Split-Path $f -Leaf) "not yet created"
    }
}

# --- vault ----
$vault = Join-Path $env:USERPROFILE ".pocketclaw\vault"
Heading "Vault"
if (Test-Path $vault) {
    foreach ($sub in @("wiki", "meetings", "research", "presentations", "speeches")) {
        $p = Join-Path $vault $sub
        if (Test-Path $p) {
            $count = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue).Count
            Kv $sub "$count files"
        }
    }
} else {
    Kv "Status" "vault not yet created (run /ingest or any /minutes /research /slides)"
}

# --- recent log lines ----
if ($Follow) {
    Heading "Tailing $stdout (Ctrl-C to stop)"
    if (Test-Path $stdout) { Get-Content $stdout -Tail $Tail -Wait }
} else {
    Heading "Last $Tail lines of stderr"
    if (Test-Path $stderr) {
        Get-Content $stderr -Tail $Tail | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "  (no stderr yet)"
    }
}
