# ─── Entra ID crawler — profile photos ───────────────────────────────────────
#
# Fetches each user's profile photo and ships it on the principals endpoint.
#
# Why this is its own phase rather than another $select attribute: a photo is
# NOT a user property in Graph. It is a separate resource per user —
#
#     GET /users/{id}/photos/{size}/$value   → image bytes, or 404
#
# — so it cannot ride the single paged /users call the way displayName or
# department do. One request per user is unavoidable, which is exactly why
# this is opt-in (selectedObjects.profilePhotos) and skipped by default.
#
# Cost control, in order of how much each saves:
#   1. Opt-in. Tenants that don't want faces pay nothing.
#   2. A fixed small size (48x48) rather than the full-resolution original.
#      Graph renders these server-side; the originals can be megabytes.
#   3. "Already known" skipping. The API tells us which principals already
#      have a photoFetchedAt, and -MaxAgeDays keeps those out of the request
#      list until they go stale. A re-run the next day fetches almost nothing.
#   4. Negative caching. A user with no photo still gets photoFetchedAt set,
#      so the 404 is not repeated on every run. In most tenants the majority
#      of accounts have no photo, so this is a large share of the saving.
#
# Requires User.Read.All, which the crawler already holds for /users — no
# additional consent.

Set-StrictMode -Version Latest

# Smallest size Graph offers. A header/detail avatar renders at 28-40 CSS px,
# so 48 covers a 2x display without storing anything larger.
$script:EntraPhotoSize = '48x48'

# Fetch one user's photo.
#
# Returns @{ found = $true; bytes = <byte[]>; contentType = <string> } when the
# user has one, @{ found = $false } when they demonstrably do not (404 / 403 /
# "no photo" 404-alike), and $null when the answer is unknown (throttling,
# transient failure). The three-way result matters: only a definite "no" may be
# written back as a negative cache entry. Writing one on a transient error
# would suppress that user's photo until the max age expired.
function Get-EntraUserPhoto {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$UserId,
        [string]$Size = $script:EntraPhotoSize
    )

    $uri = "https://graph.microsoft.com/beta/users/$UserId/photos/$Size/`$value"
    try {
        $bytes = Invoke-FGGetRequestBytes -URI $uri
        if ($null -eq $bytes -or $bytes.Length -eq 0) { return @{ found = $false } }
        # Graph always renders the sized variants as JPEG, whatever the
        # original upload format was.
        return @{ found = $true; bytes = $bytes; contentType = 'image/jpeg' }
    } catch {
        $status = Get-FGHttpStatus -ErrorRecord $_
        # 404 = no photo set. 403/401 on a single user = that mailbox/profile
        # is not readable (unlicensed accounts and most service accounts have
        # no profile photo resource at all). Both are settled answers.
        if ($status -in 401, 403, 404) { return @{ found = $false } }
        # 429 / 5xx / network — unknown, try again next run.
        return $null
    }
}

# Decide which principals to ask Graph about this run.
#
# $Candidates maps principalId → photoFetchedAt (ISO string, or $null when we
# have never looked) — every user principal the API already holds for this
# system. A principal is asked when we have never looked, when the stored value
# is unparseable, or when the answer is older than -MaxAgeDays. Photos change
# rarely, so the default keeps a daily crawl from re-downloading the tenant
# every night; the first run checks everyone.
#
# Returns an array of principal id strings.
function Select-EntraPhotoTargets {
    [CmdletBinding()]
    param(
        [hashtable]$Candidates = @{},
        [int]$MaxAgeDays = 30
    )
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-$MaxAgeDays)
    $targets = @()
    foreach ($id in $Candidates.Keys) {
        $fetchedAt = $Candidates[$id]
        if (-not $fetchedAt) { $targets += $id; continue }
        $parsed = [datetime]::MinValue
        if (-not [datetime]::TryParse($fetchedAt, [ref]$parsed)) { $targets += $id; continue }
        if ($parsed.ToUniversalTime() -lt $cutoff) { $targets += $id }
    }
    return ,$targets
}

# Shape one fetch result into a principals ingest record.
#
# Only the photo fields plus the id: the record is a PARTIAL principal update.
# The ingest upsert only touches columns present on the record, so omitting
# displayName et al. leaves the rest of the user untouched rather than blanking
# it. `photo = $null` with a photoFetchedAt set is the negative cache entry.
function ConvertTo-EntraPhotoRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$UserId,
        $Photo
    )
    $rec = @{
        id             = $UserId
        photoFetchedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($Photo -and $Photo.found) {
        $rec['photo']            = [Convert]::ToBase64String($Photo.bytes)
        $rec['photoContentType'] = $Photo.contentType
    } else {
        $rec['photo']            = $null
        $rec['photoContentType'] = $null
    }
    return $rec
}

# ─── Phase ───────────────────────────────────────────────────────────────────
#
# Works entirely off principals the API already holds (see the /crawlers/
# photo-state endpoint), so it never invents a principal and never needs the
# users list from the Principals phase.
function Sync-EntraUserPhotos {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$SystemId,
        [int]$MaxAgeDays = 30,
        [int]$BatchSize = 200,
        [System.Collections.IDictionary]$Timings
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Syncing profile photos..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Syncing profile photos' -Pct 20 -Detail 'Checking which photos are already known...'

    $candidates = Get-EntraKnownPhotoDates -SystemId $SystemId
    $targets    = Select-EntraPhotoTargets -Candidates $candidates -MaxAgeDays $MaxAgeDays

    $skipped = $candidates.Count - @($targets).Count
    Write-Host "  $(@($targets).Count) to check, $skipped already known" -ForegroundColor Gray

    $records = @()
    $found = 0; $none = 0; $unknown = 0; $i = 0

    foreach ($userId in $targets) {
        $i++
        if ($i % 100 -eq 0) {
            $pct = 20 + [int](6 * $i / [Math]::Max(1, @($targets).Count))
            Update-CrawlerProgress -Step 'Syncing profile photos' -Pct $pct -Detail "$i of $(@($targets).Count) checked..."
        }

        $photo = Get-EntraUserPhoto -UserId $userId
        # $null = we could not find out. Record nothing, so the user stays on
        # the list for the next run instead of being cached as "no photo".
        if ($null -eq $photo) { $unknown++; continue }

        if ($photo.found) { $found++ } else { $none++ }
        $records += ConvertTo-EntraPhotoRecord -UserId $userId -Photo $photo

        # Ship in small batches: base64 inflates by ~33% and the ingest body
        # limit is 50 MB, so the 5000-record default used elsewhere would be
        # far too large here.
        if ($records.Count -ge $BatchSize) {
            Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId `
                -SyncMode 'delta' -Records $records -BatchSize $BatchSize
            $records = @()
        }
    }

    if ($records.Count -gt 0) {
        Send-IngestBatch -Endpoint 'ingest/principals' -SystemId $SystemId `
            -SyncMode 'delta' -Records $records -BatchSize $BatchSize
    }

    Write-Host "  Photos: $found found, $none without, $unknown undetermined" -ForegroundColor Gray
    if ($unknown -gt 0) {
        Write-Host "  ($unknown could not be checked this run — they'll be retried next run.)" -ForegroundColor DarkGray
    }

    $sw.Stop()
    if ($Timings) { $Timings['Profile photos'] = $sw.Elapsed }
}
