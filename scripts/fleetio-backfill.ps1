# One-off Fleetio data migration driver (vehicles + maintenance + fuel).
#
# Mirrors supabase/functions/fleetio-import/index.ts mapping exactly:
#   vehicles:        FLEETIO-<id>, mi->km odometer, type mapping, status
#   maintenance_logs: FLEETIO-MAINT-<id>, skips rows with no date or unknown vehicle
#   fuel_logs:        FLEETIO-FUEL-<id>, same orphan-skipping
# Idempotent: PostgREST upserts keyed on id (Prefer: resolution=merge-duplicates).
#
# ASCII only - PowerShell 5.1 reads this file as ANSI.
#
# DRY-RUN BY DEFAULT: makes zero writes unless -Live is passed. The dry run
# prints exactly what a live run would create/update so the operator can
# review before touching the production vehicles/maintenance/fuel tables.

param([switch]$Live)

$ErrorActionPreference = "Stop"

$PROJECT_REF = "pbyeatgjnrhvfnfiublj"
$SUPABASE_URL = "https://$PROJECT_REF.supabase.co"
# Credentials come from env so they never live in version control. Set before running:
#   $env:FLEETIO_BEARER_TOKEN = "..."; $env:FLEETIO_ACCOUNT_TOKEN = "..."
$FLEETIO_BEARER = $env:FLEETIO_BEARER_TOKEN
$FLEETIO_ACCOUNT = $env:FLEETIO_ACCOUNT_TOKEN
if (-not $FLEETIO_BEARER -or -not $FLEETIO_ACCOUNT) {
  throw "Set FLEETIO_BEARER_TOKEN and FLEETIO_ACCOUNT_TOKEN env vars before running."
}
$PAGE_SIZE = 100
$CHUNK = 200

$keysJson = supabase projects api-keys --project-ref $PROJECT_REF -o json | ConvertFrom-Json
$SR = ($keysJson | Where-Object { $_.name -eq "service_role" }).api_key
if (-not $SR) { throw "could not resolve service_role key" }

$rest = @{ apikey = $SR; Authorization = "Bearer $SR"; "Content-Type" = "application/json"; Prefer = "resolution=merge-duplicates,return=minimal" }
$restRead = @{ apikey = $SR; Authorization = "Bearer $SR" }
$fs = @{ Authorization = "Token token=$FLEETIO_BEARER"; "Account-Token" = $FLEETIO_ACCOUNT; Accept = "application/json" }

# Fleetio v1 mixes two pagination styles per endpoint: vehicles/fuel_entries
# return a {records, next_cursor} envelope (cursor-based), service_entries
# returns a BARE ARRAY with classic ?page=N pagination. Handle both: parse
# the raw JSON so a bare array is detected reliably (PowerShell member
# enumeration on object arrays silently yields junk for .records).
function FetchAllPages([string]$endpoint) {
  $out = @()
  $cursor = $null
  $classic = $false
  for ($p = 1; $p -le 400; $p++) {
    $uri = "https://secure.fleetio.com/api/v1/$($endpoint)?per_page=$PAGE_SIZE"
    if ($classic) { $uri += "&page=$p" }
    elseif ($cursor) { $uri += "&start_cursor=" + [uri]::EscapeDataString($cursor) }
    $raw = $null
    foreach ($attempt in 1..4) {
      try { $raw = (Invoke-WebRequest -Uri $uri -Headers $fs -UseBasicParsing).Content; break }
      catch {
        $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 429 -and $attempt -lt 4) { Start-Sleep -Seconds (2 * $attempt); continue }
        throw
      }
    }
    $trimmed = $raw.TrimStart()
    if ($trimmed.StartsWith("[")) {
      # bare array -> classic page-based pagination
      $classic = $true
      $recs = @($raw | ConvertFrom-Json)
      $out += $recs
      if ($recs.Count -lt $PAGE_SIZE) { break }
    } else {
      $resp = $raw | ConvertFrom-Json
      $recs = @($resp.records)
      $out += $recs
      $next = $resp.next_cursor
      if (-not $next -or $next -eq $cursor) { break }
      $cursor = $next
    }
  }
  return $out
}

function MapVehicleType($name) {
  $v = ("" + $name).Trim().ToLower()
  if (-not $v) { return "equipment" }
  if ($v -match "truck|tractor|pickup") { return "truck" }
  if ($v -match "trailer") { return "trailer" }
  return "equipment"
}
function ToIntOrZero($v) {
  if ($null -eq $v) { return 0 }
  $n = 0.0
  if ([double]::TryParse($v.ToString(), [ref]$n)) { return [int][Math]::Round($n) }
  return 0
}
function OdoKm($value, $unit) {
  $raw = ToIntOrZero $value
  if ($raw -le 0) { return 0 }
  $u = ("" + $unit).Trim().ToLower()
  if ($u -eq "mi" -or $u -eq "miles" -or $u -eq "mile") { return [int][Math]::Round($raw * 1.609344) }
  return $raw
}
function ToYmd($s) {
  if (-not $s) { return $null }
  $str = $s.ToString()
  try {
    $d = [datetime]::Parse($str, [Globalization.CultureInfo]::InvariantCulture, ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal))
    return $d.ToString("yyyy-MM-dd")
  } catch {
    if ($str -match "^\d{4}-\d{2}-\d{2}$") { return $str }
    return $null
  }
}
function ToCost($cents, $amount) {
  $n = 0.0
  if ($null -ne $cents -and [double]::TryParse($cents.ToString(), [ref]$n)) { return [Math]::Round($n / 100, 2) }
  if ($null -ne $amount -and [double]::TryParse($amount.ToString(), [ref]$n)) { return [Math]::Round($n, 2) }
  return 0
}
function UpsertChunks([string]$table, $rows) {
  $count = 0
  for ($i = 0; $i -lt $rows.Count; $i += $CHUNK) {
    $end = [Math]::Min($i + $CHUNK, $rows.Count) - 1
    $batch = $rows[$i..$end]
    $json = ConvertTo-Json -InputObject @($batch) -Depth 8 -Compress
    Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/$($table)?on_conflict=id" -Method Post -Headers $rest -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
    $count += $batch.Count
  }
  return $count
}

# ---- 1. Vehicles -------------------------------------------------------------
$remoteVehicles = FetchAllPages "vehicles"
Write-Output ("Fleetio vehicles: " + $remoteVehicles.Count)

$vehicleRows = @()
foreach ($v in $remoteVehicles) {
  $meterUnit = if ($v.meter_unit) { $v.meter_unit } else { $v.primary_meter_unit }
  $active = if ($null -eq $v.is_active) { -not $v.archived_at } else { [bool]$v.is_active }
  $yearN = 0.0
  $year = 1970
  if ($null -ne $v.year -and [double]::TryParse($v.year.ToString(), [ref]$yearN)) { $year = [int]$yearN }
  $name = if ($v.vehicle_name) { $v.vehicle_name } elseif ($v.name) { $v.name } else { "Fleetio " + $v.id }
  $vehicleRows += [ordered]@{
    id       = "FLEETIO-" + $v.id
    name     = $name.ToString()
    plate    = ("" + $v.license_plate)
    year     = $year
    type     = (MapVehicleType $v.vehicle_type_name)
    vin      = ("" + $v.vin)
    odometer = (OdoKm $v.current_meter_value $meterUnit)
    status   = $(if ($active) { "operational" } else { "out-of-service" })
  }
}

# dry-run style report before writing
$existing = Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/vehicles?id=like.FLEETIO-*&select=id" -Headers $restRead
$existingIds = @{}; foreach ($e in @($existing)) { $existingIds[$e.id] = $true }
$toCreate = @($vehicleRows | Where-Object { -not $existingIds.ContainsKey($_.id) })
$toUpdate = @($vehicleRows | Where-Object { $existingIds.ContainsKey($_.id) })
Write-Output ("PLAN vehicles: create " + $toCreate.Count + ", update " + $toUpdate.Count)
foreach ($s in ($toCreate | Select-Object -First 3)) { Write-Output ("  sample create: " + $s.name + " (" + $s.type + ", " + $s.odometer + " km, " + $s.status + ")") }

if ($Live) {
  $n = UpsertChunks "vehicles" $vehicleRows
  Write-Output ("LIVE vehicles upserted: " + $n)
} else {
  Write-Output "DRY RUN - vehicles not written"
}

# Known vehicle ids for FK filtering (all vehicles, not just Fleetio ones)
$known = Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/vehicles?select=id" -Headers $restRead
$knownIds = @{}; foreach ($k in @($known)) { $knownIds[$k.id] = $true }

# ---- 2. Maintenance logs ------------------------------------------------------
$remoteMaint = FetchAllPages "service_entries"
Write-Output ("Fleetio service_entries: " + $remoteMaint.Count)
$maintRows = @{}
$skippedMaint = 0
foreach ($s in $remoteMaint) {
  $date = $null
  if ($s.service_date) { $date = ToYmd $s.service_date }
  if (-not $date -and $s.date) { $date = ToYmd $s.date }
  if (-not $date -and $s.completed_at) { $date = ToYmd $s.completed_at }
  if (-not $date -and $s.started_at) { $date = ToYmd $s.started_at }
  if (-not $date) { $skippedMaint++; continue }
  $vid = "FLEETIO-" + $s.vehicle_id
  if (-not $knownIds.ContainsKey($vid)) { $skippedMaint++; continue }
  $vendor = if ($s.vendor_name) { $s.vendor_name } elseif ($s.vendor -and $s.vendor.name) { $s.vendor.name } else { "" }
  $meterVal = if ($null -ne $s.meter_value) { $s.meter_value } elseif ($s.meter_entry -and $null -ne $s.meter_entry.value) { $s.meter_entry.value } else { 0 }
  $notes = if ($s.description) { $s.description } elseif ($s.comments) { $s.comments } elseif ($s.general_notes) { $s.general_notes } else { "" }
  $maintRows["FLEETIO-MAINT-" + $s.id] = [ordered]@{
    id           = "FLEETIO-MAINT-" + $s.id
    vehicle_id   = $vid
    type         = $(if ($s.label) { $s.label.ToString() } else { "Service" })
    performed_by = $vendor.ToString()
    date         = $date
    mileage      = (ToIntOrZero $meterVal)
    cost         = (ToCost $s.total_amount_cents $s.total_amount)
    notes        = $notes.ToString()
  }
}
$maintList = @($maintRows.Values)
Write-Output ("PLAN maintenance_logs: import " + $maintList.Count + ", skipped " + $skippedMaint + " (no date / unknown vehicle)")
if ($Live) {
  $n = UpsertChunks "maintenance_logs" $maintList
  Write-Output ("LIVE maintenance_logs upserted: " + $n)
} else {
  Write-Output "DRY RUN - maintenance_logs not written"
}

# ---- 3. Fuel logs --------------------------------------------------------------
$remoteFuel = FetchAllPages "fuel_entries"
Write-Output ("Fleetio fuel_entries: " + $remoteFuel.Count)
$fuelRows = @{}
$skippedFuel = 0
foreach ($f in $remoteFuel) {
  $date = ToYmd $f.date
  if (-not $date) { $skippedFuel++; continue }
  $vid = "FLEETIO-" + $f.vehicle_id
  if (-not $knownIds.ContainsKey($vid)) { $skippedFuel++; continue }
  $galRaw = if ($null -ne $f.us_gallons) { $f.us_gallons } elseif ($null -ne $f.liquid_amount) { $f.liquid_amount } else { 0 }
  $gal = 0.0; [void][double]::TryParse($galRaw.ToString(), [ref]$gal)
  $loc = if ($f.location) { $f.location } elseif ($f.vendor_name) { $f.vendor_name } elseif ($f.vendor -and $f.vendor.name) { $f.vendor.name } else { "" }
  $fuelRows["FLEETIO-FUEL-" + $f.id] = [ordered]@{
    id         = "FLEETIO-FUEL-" + $f.id
    vehicle_id = $vid
    date       = $date
    gallons    = [Math]::Round($gal, 2)
    cost       = (ToCost $f.total_amount_cents $f.total_amount)
    location   = $loc.ToString()
  }
}
$fuelList = @($fuelRows.Values)
Write-Output ("PLAN fuel_logs: import " + $fuelList.Count + ", skipped " + $skippedFuel)
if ($Live) {
  $n = UpsertChunks "fuel_logs" $fuelList
  Write-Output ("LIVE fuel_logs upserted: " + $n)
} else {
  Write-Output "DRY RUN - fuel_logs not written"
}

Write-Output $(if ($Live) { "DONE - Fleetio migration complete" } else { "DONE - dry run only, nothing written" })
foreach ($t in @("vehicles", "maintenance_logs", "fuel_logs")) {
  $head = Invoke-WebRequest -Uri "$SUPABASE_URL/rest/v1/$($t)?select=id&limit=1" -Headers @{ apikey = $SR; Authorization = "Bearer $SR"; Prefer = "count=exact" } -Method Head -UseBasicParsing
  Write-Output ($t + " total in DB: " + $head.Headers["Content-Range"])
}
