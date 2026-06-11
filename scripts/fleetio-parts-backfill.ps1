# One-off Fleetio parts catalog -> inventory_items import.
#
# Parts come from /api/v1/parts (id, number=SKU, description, archived_at).
# Stock counts come from /api/v1/inventory_journal_entries: the most recent
# entry per part_id carries current_quantity. Parts with no journal entries
# default to qty 0 (mechanics adjust in-app afterwards).
#
# Existing manually-created inventory rows are preserved: import ids are
# namespaced FLEETIO-PART-<id> and colliding SKUs get a -<id> suffix.
# DRY-RUN BY DEFAULT; pass -Live to write.
# ASCII only - PowerShell 5.1 reads this file as ANSI.

param([switch]$Live)
$ErrorActionPreference = "Stop"

$PROJECT_REF = "pbyeatgjnrhvfnfiublj"
$SUPABASE_URL = "https://$PROJECT_REF.supabase.co"
$FLEETIO_BEARER = $env:FLEETIO_BEARER_TOKEN
$FLEETIO_ACCOUNT = $env:FLEETIO_ACCOUNT_TOKEN
if (-not $FLEETIO_BEARER -or -not $FLEETIO_ACCOUNT) {
  throw "Set FLEETIO_BEARER_TOKEN and FLEETIO_ACCOUNT_TOKEN env vars before running."
}

$keysJson = supabase projects api-keys --project-ref $PROJECT_REF -o json | ConvertFrom-Json
$SR = ($keysJson | Where-Object { $_.name -eq "service_role" }).api_key
$rest = @{ apikey = $SR; Authorization = "Bearer $SR"; "Content-Type" = "application/json"; Prefer = "resolution=merge-duplicates,return=minimal" }
$restRead = @{ apikey = $SR; Authorization = "Bearer $SR" }
$fs = @{ Authorization = "Token token=$FLEETIO_BEARER"; "Account-Token" = $FLEETIO_ACCOUNT; Accept = "application/json" }

# Dual-style pagination (cursor envelope OR bare array + page=N), same as
# fleetio-backfill.ps1.
function FetchAllPages([string]$endpoint) {
  $out = @(); $cursor = $null; $classic = $false
  for ($p = 1; $p -le 400; $p++) {
    $uri = "https://secure.fleetio.com/api/v1/$($endpoint)?per_page=100"
    if ($classic) { $uri += "&page=$p" } elseif ($cursor) { $uri += "&start_cursor=" + [uri]::EscapeDataString($cursor) }
    $raw = $null
    foreach ($attempt in 1..4) {
      try { $raw = (Invoke-WebRequest -Uri $uri -Headers $fs -UseBasicParsing).Content; break }
      catch { $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }; if ($code -eq 429 -and $attempt -lt 4) { Start-Sleep -Seconds (2 * $attempt); continue }; throw }
    }
    if ($raw.TrimStart().StartsWith("[")) {
      $classic = $true
      $recs = @($raw | ConvertFrom-Json)
      $out += $recs
      if ($recs.Count -lt 100) { break }
    } else {
      $resp = $raw | ConvertFrom-Json
      $out += @($resp.records)
      $next = $resp.next_cursor
      if (-not $next -or $next -eq $cursor) { break }
      $cursor = $next
    }
  }
  return $out
}

# ---- 1. Parts + latest stock counts ----------------------------------------
$parts = FetchAllPages "parts"
Write-Output ("Fleetio parts fetched: " + $parts.Count)
$journal = FetchAllPages "inventory_journal_entries"
Write-Output ("inventory journal entries fetched: " + $journal.Count)

# Latest current_quantity per part (entries assumed mixed order; keep newest
# created_at per part_id).
$qty = @{}
$latest = @{}
foreach ($e in $journal) {
  if ($null -eq $e.part_id -or $null -eq $e.current_quantity) { continue }
  $k = [string]$e.part_id
  $ts = [datetime]$e.created_at
  if (-not $latest.ContainsKey($k) -or $ts -gt $latest[$k]) {
    $latest[$k] = $ts
    $qty[$k] = [int][Math]::Max(0, [Math]::Round([double]$e.current_quantity))
  }
}
Write-Output ("parts with stock counts: " + $qty.Count)

# ---- 2. Map -> inventory_items ----------------------------------------------
$existingSkus = @{}
(Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/inventory_items?select=id,sku" -Headers $restRead) | ForEach-Object {
  if ($_.id -notlike "FLEETIO-PART-*") { $existingSkus[$_.sku] = $true }
}
Write-Output ("pre-existing manual inventory rows (SKUs protected): " + $existingSkus.Count)

$rowsById = @{}
$seenSku = @{}
$skippedArchived = 0
foreach ($p in $parts) {
  if ($p.archived_at) { $skippedArchived++; continue }
  $id = "FLEETIO-PART-" + $p.id
  $sku = ("" + $p.number).Trim()
  if (-not $sku) { $sku = "FL-" + $p.id }
  if ($existingSkus.ContainsKey($sku) -or $seenSku.ContainsKey($sku)) { $sku = $sku + "-" + $p.id }
  $seenSku[$sku] = $true
  $name = ("" + $p.description) -replace "\s+", " "
  $name = $name.Trim()
  if (-not $name) { $name = $sku }
  if ($name.Length -gt 120) { $name = $name.Substring(0, 117) + "..." }
  $rowsById[$id] = [ordered]@{
    id          = $id
    name        = $name
    sku         = $sku
    qty_on_hand = $(if ($qty.ContainsKey([string]$p.id)) { $qty[[string]$p.id] } else { 0 })
  }
}
$rows = @($rowsById.Values)
$withStock = @($rows | Where-Object { $_.qty_on_hand -gt 0 }).Count
Write-Output ("PLAN: import " + $rows.Count + " parts (" + $withStock + " with stock > 0), skipped " + $skippedArchived + " archived")
$rows | Select-Object -First 5 | ForEach-Object { "  sample: " + $_.sku + " | " + $_.name + " | qty " + $_.qty_on_hand }

if (-not $Live) { Write-Output "DRY RUN - nothing written"; exit 0 }

# ---- 3. Upsert ----------------------------------------------------------------
$count = 0
for ($i = 0; $i -lt $rows.Count; $i += 200) {
  $end = [Math]::Min($i + 200, $rows.Count) - 1
  $json = ConvertTo-Json -InputObject @($rows[$i..$end]) -Depth 4 -Compress
  Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/inventory_items?on_conflict=id" -Method Post -Headers $rest -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
  $count += ($end - $i + 1)
}
Write-Output ("LIVE: upserted " + $count + " inventory items")
$total = (Invoke-WebRequest -Uri "$SUPABASE_URL/rest/v1/inventory_items?select=id&limit=1" -Headers ($restRead + @{Prefer="count=exact"}) -Method Head -UseBasicParsing).Headers["Content-Range"] -replace ".*/", ""
Write-Output ("inventory_items total in DB now: " + $total)
