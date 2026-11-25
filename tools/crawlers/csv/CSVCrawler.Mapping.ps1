<#
.SYNOPSIS
    Applies the wizard-configured column mapping and per-file delimiter when the
    CSV crawler reads a file.

.DESCRIPTION
    The crawler used to accept exactly one shape: the canonical Identity Atlas
    schema, semicolon-delimited, in files named Users.csv / Resources.csv / ….
    Anything else needed a hand-written pre-import script. A config may now carry
    a per-file section — which uploaded file feeds which schema slot, that file's
    delimiter, and which of its columns stands for which schema field — produced
    by the wizard and applied here, on every run. Uploaded files are never
    rewritten.

    Everything in this file is PURE except Get-CsvFileSpec, the thin wrapper
    that reads the crawler's scope ($CsvFileSettings, $Delimiter) exactly like
    the Read-Csv* helpers do, and Write-CsvFileConfigWarning, which lists the
    folder the entry point passes it. The rules themselves take explicit parameters and return values,
    so they unit-test against in-memory fixtures with no mocks
    (test/unit/CSVCrawlerMapping.Tests.ps1).

    The crawler NEVER detects anything: delimiter detection happens once, in the
    wizard, where the admin sees and can override what it chose
    (tools/crawlers/csv/csvMapping.js). Here we only apply stored values, and a
    stored value that no longer fits its file fails the job by name rather than
    being guessed around.

    Mapping is applied at the header/row boundary, before any shaping — so the
    record shapers, dedup, streaming and reconcile scopes downstream see the
    canonical schema and are untouched by this feature.
#>

# ─── Slot ↔ canonical file name ──────────────────────────────────
# csv-slots.json is the one declaration of the schema slots (the wizard reads
# the same file for its slot dropdown), so the slot keys a config stores are
# never a second hand-kept list on this side.
function Get-CsvSlots {
    [CmdletBinding()]
    param([string]$Path)
    if (-not $Path) { $Path = Join-Path $PSScriptRoot 'csv-slots.json' }
    if ($null -eq $script:CsvSlotsCache -or $script:CsvSlotsPath -ne $Path) {
        $script:CsvSlotsCache = @(Get-Content $Path -Raw | ConvertFrom-Json)
        $script:CsvSlotsPath  = $Path
    }
    return $script:CsvSlotsCache
}

# The slot key a canonical file name belongs to, or $null.
function Get-CsvSlotKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$CanonicalName, $Slots)
    if (-not $Slots) { $Slots = Get-CsvSlots }
    foreach ($s in $Slots) {
        if ($s.file -eq $CanonicalName) { return $s.key }
    }
    return $null
}

# ─── Delimiters ──────────────────────────────────────────────────
# A tab was stored for years as the two-character string "\t" (a JSX attribute
# does not process escapes, so <option value="\t"> stored a backslash and a t).
# Import-Csv -Delimiter cannot bind that as a [char] and the fast parser would
# have split on the backslash, so a Tab-configured job simply failed. The wizard
# stores U+0009 now; normalizing the legacy form here means a config saved before
# that starts working without being re-saved.
function Resolve-CsvDelimiterChar {
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$Delimiter, [string]$Default = ';')
    if ([string]::IsNullOrEmpty($Delimiter)) { return $Default }
    if ($Delimiter -eq '\t') { return "`t" }
    return $Delimiter
}

# ─── The per-file config entry ───────────────────────────────────
# The `files` section is keyed by uploaded file name:
#   { "ad_users.csv": { slot, delimiter, columns: { <SchemaField>: <sourceColumn> },
#                       split: { field, delimiter } } }
# Every key is optional; a config with no `files` section at all behaves exactly
# as it did before this existed.

# The schema-field → source-column map of an entry, as a hashtable; $null when
# the entry maps nothing (the Identity Atlas-schema case, which bypasses mapping
# entirely).
function Get-CsvEntryMapping {
    [CmdletBinding()]
    param($Entry)
    if ($Entry -isnot [hashtable]) { return $null }
    $columns = $Entry['columns']
    if ($columns -isnot [hashtable]) { return $null }
    $map = @{}
    foreach ($field in $columns.Keys) {
        $source = [string]$columns[$field]
        if ($source) { $map[[string]$field] = $source }
    }
    if ($map.Count -eq 0) { return $null }
    return $map
}

# The one multi-value split an entry declares, as @{ field; delimiter }, or $null.
#
# The stored shape stays generic (an object, or a list of them) so a later slice
# can extend it — but exactly one split per file is allowed today, on the
# Assignments slot, on one of its two identifying fields. More than one would
# multiply a row out into a cartesian product, so the job fails naming the file
# instead of loading that.
function Get-CsvSplitSpec {
    [CmdletBinding()]
    param($Entry, [string]$SlotKey, [string]$FileName)
    if ($Entry -isnot [hashtable]) { return $null }
    $raw = @($Entry['split'] | Where-Object { $_ -is [hashtable] })
    if ($raw.Count -eq 0) { return $null }
    if ($raw.Count -gt 1) {
        throw "$FileName declares $($raw.Count) multi-value splits; exactly one is supported. Fix the column mapping for this file in Admin → Crawlers."
    }
    $split = $raw[0]
    $field = [string]$split['field']
    $delimiter = Resolve-CsvDelimiterChar -Delimiter ([string]$split['delimiter']) -Default ''
    if (-not $field -or -not $delimiter) { return $null }
    if ($SlotKey -ne 'assignments') {
        throw "$FileName declares a multi-value split on '$field', but splitting is only supported for the Assignments slot."
    }
    if ($field -notin @('ResourceExternalId', 'UserExternalId')) {
        throw "$FileName declares a multi-value split on '$field'; only ResourceExternalId or UserExternalId can be split."
    }
    return @{ field = $field; delimiter = $delimiter }
}

# How to read the file that feeds one schema slot:
#   @{ FileName; Delimiter; Mapping; Split; Slot }
#
# The config records which uploaded file feeds which slot — without it a file
# named ad_users.csv would simply never be read, because every phase asks for its
# canonical name. No entry for the slot (or no `files` section at all) means the
# canonical name, the config-level delimiter and no mapping: today's behaviour,
# unchanged.
#
# Two entries claiming one slot is ambiguous — one file per slot is this slice —
# so it fails naming both rather than picking one (Find-CsvSlotClaim).

# The uploaded file name that claims a slot, or $null when none does. Throws
# naming every claimant when more than one does.
function Find-CsvSlotClaim {
    [CmdletBinding()]
    [OutputType([string])]
    param([hashtable]$Files, [string]$SlotKey)
    if (-not $SlotKey -or -not $Files) { return $null }
    # -is [hashtable]: a malformed entry must not make indexing throw an error
    # that says nothing about which config key is wrong.
    $claims = @($Files.Keys | Where-Object { $Files[$_] -is [hashtable] -and [string]$Files[$_]['slot'] -eq $SlotKey } | Sort-Object)
    if ($claims.Count -gt 1) {
        throw "$($claims.Count) files are mapped to the '$SlotKey' slot ($($claims -join ', ')); each slot takes one file."
    }
    if ($claims.Count -eq 1) { return [string]$claims[0] }
    return $null
}

function Resolve-CsvFileSpec {
    [CmdletBinding()]
    param([hashtable]$Files, [string]$CanonicalName, [string]$DefaultDelimiter = ';', $Slots)
    $slotKey = Get-CsvSlotKey -CanonicalName $CanonicalName -Slots $Slots
    $claim = Find-CsvSlotClaim -Files $Files -SlotKey $slotKey
    $name  = if ($claim) { $claim } else { $CanonicalName }
    $entry = if ($Files) { $Files[$name] } else { $null }
    $stored = if ($entry -is [hashtable]) { [string]$entry['delimiter'] } else { '' }
    return @{
        FileName  = $name
        Slot      = $slotKey
        Delimiter = Resolve-CsvDelimiterChar -Delimiter $stored -Default $DefaultDelimiter
        Mapping   = Get-CsvEntryMapping -Entry $entry
        Split     = Get-CsvSplitSpec -Entry $entry -SlotKey $slotKey -FileName $name
    }
}

# Scope-reading wrapper the phases call: the same spec, resolved against the
# crawler's own $CsvFileSettings / $Delimiter.
function Get-CsvFileSpec {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CanonicalName)
    return Resolve-CsvFileSpec -Files $CsvFileSettings -CanonicalName $CanonicalName -DefaultDelimiter $Delimiter
}

# ─── Applying a mapping ──────────────────────────────────────────

# source column → schema field, the direction a row is renamed in. Throws when
# two schema fields claim one source column: one file feeding several schema
# slots is a later slice, and silently dropping one of the two fields is the kind
# of quiet wrong answer this feature exists to avoid.
function Get-CsvMappingRenames {
    [CmdletBinding()]
    param([hashtable]$Mapping, [string]$FileName)
    $renames = @{}
    foreach ($field in ($Mapping.Keys | Sort-Object)) {
        $source = [string]$Mapping[$field]
        if (-not $source) { continue }
        if ($renames.ContainsKey($source)) {
            throw "$FileName maps column '$source' to both '$($renames[$source])' and '$field'; a source column feeds one schema field."
        }
        $renames[$source] = $field
    }
    return $renames
}

# The file's header after mapping: each mapped source column renamed to its
# schema field, every other column kept under its SOURCE name — which is what
# makes an unmapped column an extended attribute named the way the source named
# it. Validation downstream (Assert-Columns, the Get-Csv*Index guards) therefore
# runs on schema names, as it always has.
#
# A mapping naming a column the file does not have fails the job, naming the file
# and the column. The alternative — carrying on with that field unmapped — would
# report success while silently dropping it.
function ConvertTo-CsvMappedColumns {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]]$Columns, [hashtable]$Mapping, [string]$FileName)
    if (-not $Mapping -or $Mapping.Count -eq 0) { return , [string[]]@($Columns) }
    $renames = Get-CsvMappingRenames -Mapping $Mapping -FileName $FileName
    $byLower = @{}
    for ($i = 0; $i -lt $Columns.Length; $i++) { $byLower[$Columns[$i].ToLowerInvariant()] = $i }
    $missing = @($renames.Keys | Where-Object { -not $byLower.ContainsKey($_.ToLowerInvariant()) } | Sort-Object)
    if ($missing.Count -gt 0) {
        $named = @($missing | ForEach-Object { "$_ (mapped to $($renames[$_]))" })
        throw "$FileName no longer has the mapped column(s): $($named -join ', '). Found: $($Columns -join ', '). Re-map this file in Admin → Crawlers."
    }
    $out = [string[]]@($Columns)
    foreach ($source in $renames.Keys) { $out[$byLower[$source.ToLowerInvariant()]] = $renames[$source] }
    return , $out
}

# The slow path's row shape: rename an Import-Csv row's properties through the
# same renames, keeping every other property as it is. Property ORDER is kept so
# the row still reads like the file.
function ConvertTo-CsvMappedRow {
    [CmdletBinding()]
    param($Row, [hashtable]$Renames)
    if (-not $Renames -or $Renames.Count -eq 0) { return $Row }
    $out = [ordered]@{}
    foreach ($p in $Row.PSObject.Properties) {
        $name = if ($Renames.ContainsKey($p.Name)) { $Renames[$p.Name] } else { $p.Name }
        $out[$name] = $p.Value
    }
    return [pscustomobject]$out
}

# Rename a whole slow-path file's rows. Validates the header first (through
# ConvertTo-CsvMappedColumns, so the "mapped column is gone" failure is the same
# message on both paths), then maps every row.
function ConvertTo-CsvMappedRows {
    [CmdletBinding()]
    param($Rows, [hashtable]$Mapping, [string]$FileName)
    if (-not $Mapping -or $Mapping.Count -eq 0 -or -not $Rows -or $Rows.Count -eq 0) { return , $Rows }
    $columns = [string[]]@($Rows[0].PSObject.Properties.Name)
    [void](ConvertTo-CsvMappedColumns -Columns $columns -Mapping $Mapping -FileName $FileName)
    $renames = Get-CsvMappingRenames -Mapping $Mapping -FileName $FileName
    return , @(foreach ($row in $Rows) { ConvertTo-CsvMappedRow -Row $row -Renames $renames })
}

# ─── Multi-value cells ───────────────────────────────────────────
# One assignment row per value in a cell like "user1;user2;user3". Empty segments
# are skipped and every kept value is trimmed.
#
# A cell with no split delimiter in it is passed through untouched, which is both
# the common case and the cheap one: Assignments runs to tens of millions of rows
# and a clone per row would be felt.
function Split-CsvMultiValueRows {
    [CmdletBinding()]
    param($Rows, [int]$Index, [string]$Delimiter)
    if ($Index -lt 0 -or [string]::IsNullOrEmpty($Delimiter)) { return , $Rows }
    $sep = [string[]]@($Delimiter)
    return , @(foreach ($cells in $Rows) {
        if ($cells.Length -le $Index) { , $cells; continue }
        $value = [string]$cells[$Index]
        if ($value.IndexOf($Delimiter) -lt 0) { , $cells; continue }
        foreach ($part in $value.Split($sep, [System.StringSplitOptions]::None)) {
            $one = $part.Trim()
            if (-not $one) { continue }
            $copy = [string[]]$cells.Clone()
            $copy[$Index] = $one
            , $copy
        }
    })
}

# ─── Config sanity, reported once per run ────────────────────────

# The configured files that are not in the folder. A mapped file that was never
# uploaded (or was deleted) is named rather than silently treated as "the slot is
# empty": the phase then applies its own optional/required rule, exactly as it
# does for a missing canonical file.
function Get-CsvMissingConfiguredFiles {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([hashtable]$Files, [string[]]$Present)
    if (-not $Files -or $Files.Count -eq 0) { return @() }
    $have = [System.Collections.Generic.HashSet[string]]::new([string[]]@($Present), [System.StringComparer]::OrdinalIgnoreCase)
    return @($Files.Keys | Where-Object { -not $have.Contains($_) } | Sort-Object)
}

# Say what the per-file config is doing, and warn about the files it names that
# are not there. The entry point passes its own $CsvFileSettings / $CsvFolder.
function Write-CsvFileConfigWarning {
    [CmdletBinding()]
    param([hashtable]$Files, [string]$Folder)
    if (-not $Files -or $Files.Count -eq 0) { return }
    $present = @()
    if (Test-Path $Folder) { $present = @(Get-ChildItem -Path $Folder -File | ForEach-Object { $_.Name }) }
    Write-Host "  $($Files.Count) file(s) have their own mapping/delimiter in this config" -ForegroundColor Gray
    $missing = Get-CsvMissingConfiguredFiles -Files $Files -Present $present
    if ($missing.Count -gt 0) {
        Write-Host "  WARNING: configured file(s) not found in $Folder and skipped: $($missing -join ', ')" -ForegroundColor Yellow
    }
}
