# One-off Formstack backfill driver.
#
# The formstack-import edge function is incremental but a single invocation
# can't page through all ~15k submissions before Supabase's wall-clock limit
# kills it. This script runs the SAME sync logic from a workstation with no
# time limit: per-form high-water mark -> Formstack v2025 pages -> PostgREST
# upserts keyed FS-<id>. Safe to re-run any time; it only fetches new rows.
#
# Usage:  powershell -File scripts/formstack-backfill.ps1
# Requires: supabase CLI logged in + linked (for the service key),
#           FORMSTACK_ACCESS_TOKEN below or in env.

$ErrorActionPreference = "Stop"

$PROJECT_REF = "pbyeatgjnrhvfnfiublj"
$SUPABASE_URL = "https://$PROJECT_REF.supabase.co"
$FS_TOKEN = $env:FORMSTACK_ACCESS_TOKEN
if (-not $FS_TOKEN) { throw "Set FORMSTACK_ACCESS_TOKEN env var before running." }
$PAGE_SIZE = 100
$MAX_PAGES = 200
$CHUNK = 200

$keysJson = supabase projects api-keys --project-ref $PROJECT_REF -o json | ConvertFrom-Json
$SR = ($keysJson | Where-Object { $_.name -eq "service_role" }).api_key
if (-not $SR) { throw "could not resolve service_role key from supabase CLI" }

$restHeaders = @{ apikey = $SR; Authorization = "Bearer $SR"; "Content-Type" = "application/json"; Prefer = "resolution=merge-duplicates,return=minimal" }
$fsHeaders = @{ Authorization = "Bearer $FS_TOKEN"; Accept = "application/json" }
$tz = [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")

function ToUtcIso([string]$local) {
  # 'yyyy-MM-dd HH:mm:ss' account-local (America/Toronto) -> UTC ISO8601
  $dt = [datetime]::ParseExact($local.Substring(0, 19).Replace("T", " "), "yyyy-MM-dd HH:mm:ss", $null)
  $dt = [datetime]::SpecifyKind($dt, [DateTimeKind]::Unspecified)
  return [TimeZoneInfo]::ConvertTimeToUtc($dt, $tz).ToString("yyyy-MM-ddTHH:mm:ssZ")
}
function ToAccountLocal([string]$utcIso) {
  $utc = ([datetime]::Parse($utcIso)).ToUniversalTime()
  return [TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz).ToString("yyyy-MM-dd HH:mm:ss")
}
function BuildSummary($data) {
  $parts = @()
  foreach ($f in $data) {
    if ($null -eq $f.displayValue) { continue }
    $v = ($f.displayValue.ToString() -replace "\s+", " ").Trim()
    if (-not $v) { continue }
    $parts += $v
    if ($parts.Count -ge 4) { break }
  }
  $s = $parts -join " | "
  if ($s.Length -gt 240) { return $s.Substring(0, 237) + "..." }
  return $s
}

# ---- 1. List forms ----------------------------------------------------------
$allForms = @()
for ($p = 1; $p -le 20; $p++) {
  $page = Invoke-RestMethod -Uri "https://www.formstack.com/api/v2025/forms?pageNumber=$p&pageSize=50" -Headers $fsHeaders
  $allForms += $page.forms
  if ($p -ge $page.page.totalPages) { break }
}
$targets = $allForms | Where-Object { $_.active -and $_.submissionsCount -gt 0 }
Write-Output ("targets: " + $targets.Count + " forms, " + (($targets | Measure-Object -Sum submissionsCount).Sum) + " total submissions on Formstack side")

$grandFetched = 0
$grandUpserted = 0

foreach ($form in $targets) {
  $fid = $form.id
  $fname = if ($form.name) { $form.name.ToString() } else { "Form $fid" }

  # High-water mark
  $hw = Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/formstack_submissions?form_id=eq.$fid&submitted_at=not.is.null&select=submitted_at&order=submitted_at.desc&limit=1" -Headers $restHeaders
  $minTime = ""
  if ($hw -and $hw.Count -gt 0 -and $hw[0].submitted_at) {
    $minTime = "&minTime=" + [uri]::EscapeDataString((ToAccountLocal $hw[0].submitted_at))
  }

  $rowsById = @{}
  for ($p = 1; $p -le $MAX_PAGES; $p++) {
    $uri = "https://www.formstack.com/api/v2025/forms/$fid/submissions?pageNumber=$p&pageSize=$PAGE_SIZE&data=true&dataFormat=standardized&expandData=true&order=ASC$minTime"
    $resp = $null
    foreach ($attempt in 1..4) {
      try { $resp = Invoke-RestMethod -Uri $uri -Headers $fsHeaders; break }
      catch {
        $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 429 -and $attempt -lt 4) { Start-Sleep -Seconds (2 * $attempt); continue }
        throw
      }
    }
    $subs = @($resp.submissions)
    foreach ($s in $subs) {
      $data = if ($s.data) { @($s.data) } else { @() }
      $submittedAt = $null
      if ($s.timestamp) { $submittedAt = ToUtcIso $s.timestamp.ToString() }
      $rowsById["FS-" + $s.id] = [ordered]@{
        id            = "FS-" + $s.id
        submission_id = [long]$s.id
        form_id       = [long]$s.formId
        form_name     = $fname
        submitted_at  = $submittedAt
        summary       = (BuildSummary $data)
        data          = $data
      }
    }
    if ($p -ge $resp.page.totalPages -or $subs.Count -eq 0) { break }
  }

  $rows = @($rowsById.Values)
  $grandFetched += $rows.Count
  $upserted = 0
  for ($i = 0; $i -lt $rows.Count; $i += $CHUNK) {
    $end = [Math]::Min($i + $CHUNK, $rows.Count) - 1
    $batch = $rows[$i..$end]
    $json = ConvertTo-Json -InputObject @($batch) -Depth 12 -Compress
    Invoke-RestMethod -Uri "$SUPABASE_URL/rest/v1/formstack_submissions?on_conflict=id" -Method Post -Headers $restHeaders -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
    $upserted += $batch.Count
  }
  $grandUpserted += $upserted
  if ($rows.Count -gt 0) {
    Write-Output ("form " + $fid + " (" + $fname + "): fetched " + $rows.Count + ", upserted " + $upserted)
  }
}

Write-Output ("DONE - fetched " + $grandFetched + ", upserted " + $grandUpserted)
$final = Invoke-WebRequest -Uri "$SUPABASE_URL/rest/v1/formstack_submissions?select=id&limit=1" -Headers @{ apikey = $SR; Authorization = "Bearer $SR"; Prefer = "count=exact" } -Method Head -UseBasicParsing
Write-Output ("DB total now: " + $final.Headers["Content-Range"])
