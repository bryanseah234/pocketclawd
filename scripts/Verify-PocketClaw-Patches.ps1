param(
  [int]$WaitSeconds = 120
)
# Verify-PocketClaw-Patches.ps1
# Tails service.stdout.log, looks for new tracer markers introduced by the May 23 patches:
#   - "Inbound DM received" lines now carry attachments= / textLen= / isMention=
#   - new "Inbound new message" / "Inbound subscribed message" tracer lines (chat-sdk-bridge.ts)
#   - WA group engage match producing "Message routed ... engage_mode=\"pattern\""
#
# Prints a verdict at the end so we don't have to eyeball.

$ErrorActionPreference = 'Stop'
$Log = 'X:\PocketClawData\logs\service.stdout.log'
if (-not (Test-Path $Log)) { Write-Error "log not found: $Log"; exit 2 }

# Confirm service PID + start time first
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'cavemem' } |
  Select-Object -First 1
if (-not $proc) { Write-Host "[FAIL] no PocketClaw node.exe running"; exit 3 }
$started = $proc.CreationDate
Write-Host ("[INFO] service PID={0} started={1}" -f $proc.ProcessId, $started)

# Anchor at current end-of-file so we only see NEW lines
$startSize = (Get-Item $Log).Length
Write-Host ("[INFO] tailing from byte={0} for {1}s" -f $startSize, $WaitSeconds)
Write-Host "[INFO] now send your test messages (TG photo to bot DM, WA '@PocketClaw hello again' to Prawn Hub)"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$buf = New-Object System.Collections.Generic.List[string]
$pos = $startSize
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  $cur = (Get-Item $Log).Length
  if ($cur -gt $pos) {
    $fs = [System.IO.File]::Open($Log, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    [void]$fs.Seek($pos, [System.IO.SeekOrigin]::Begin)
    $br = New-Object System.IO.StreamReader($fs)
    $chunk = $br.ReadToEnd()
    $br.Close(); $fs.Close()
    foreach ($line in ($chunk -split "`r?`n")) {
      if ($line) {
        $buf.Add($line)
        # echo only interesting lines live
        if ($line -match 'Inbound|attachments=|textLen=|Message routed|onDirectMessage|onNewMessage|onSubscribedMessage|engage_mode|delivered|whatsapp.*Media') {
          Write-Host "  $line"
        }
      }
    }
    $pos = $cur
  }
}

Write-Host ""
Write-Host "==================== VERDICT ===================="
$all = $buf -join "`n"

# Patch-in-effect markers
$hasAttachmentsField = $all -match 'attachments=\d'
$hasTextLenField     = $all -match 'textLen=\d'
$hasNewMsgTracer     = $all -match 'Inbound new message|Inbound subscribed message'
$patchActive = $hasAttachmentsField -or $hasTextLenField -or $hasNewMsgTracer

if ($patchActive) {
  Write-Host "[OK ] new patches ACTIVE (tracer fields present)"
} else {
  Write-Host "[FAIL] new patches NOT detected — service is still running pre-patch code"
}

# TG photo path
$tgPhoto = $buf | Where-Object { $_ -match 'Inbound DM received.*telegram' }
if ($tgPhoto) {
  Write-Host "[OK ] TG DM events seen: $($tgPhoto.Count)"
  $tgPhoto | ForEach-Object {
    if ($_ -match 'attachments=(\d+)') { Write-Host ("       attachments={0} -> {1}" -f $Matches[1], $_) }
    else { Write-Host ("       (no attachments field) -> {0}" -f $_) }
  }
} else {
  Write-Host "[??] no TG 'Inbound DM received' in window — TG SDK may not have delivered the photo"
  $sdkTrace = $buf | Where-Object { $_ -match 'Inbound new message|Inbound subscribed message' } | Select-Object -First 5
  if ($sdkTrace) { Write-Host "    SDK-level events did fire:"; $sdkTrace | ForEach-Object { Write-Host "       $_" } }
}

# WA group engage
$waRouted = $buf | Where-Object { $_ -match 'Message routed.*whatsapp.*engage_mode="pattern"' }
$waInbound = $buf | Where-Object { $_ -match 'whatsapp' -and $_ -match 'Inbound|received' }
if ($waRouted) {
  Write-Host "[OK ] WA group engage matched (case-insensitive patch worked):"
  $waRouted | ForEach-Object { Write-Host "       $_" }
} elseif ($waInbound) {
  Write-Host "[??] WA inbound seen but not routed — check engage pattern / sender_scope"
  $waInbound | Select-Object -First 5 | ForEach-Object { Write-Host "       $_" }
} else {
  Write-Host "[??] no WA inbound at all — message may not have reached service"
}

# Delivered replies
$delivered = $buf | Where-Object { $_ -match 'Message delivered' }
if ($delivered) {
  Write-Host "[OK ] replies delivered: $($delivered.Count)"
  $delivered | ForEach-Object { Write-Host "       $_" }
}

Write-Host "================================================="
