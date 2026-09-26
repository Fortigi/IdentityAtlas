<#
.SYNOPSIS
    End-of-run verification for the SQL Database crawler: what the source said
    against what the database now holds, per reconcile scope.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Phases.ps1. A streamed run can only report what
    it SENT, and the ingest's inserted/updated totals count every record it was
    handed: eight source rows that share one id land as ONE row and are still
    reported as eight. So a run that loads an eighth of its source used to finish
    "successfully". This file closes that gap:

      * While streaming, every scope that has a key small enough to hold
        (principals, resources, relationships) remembers how many rows it saw and
        how many DISTINCT keys. Rows > keys means the source returned several rows
        per id; only one of each can survive, and the run fails naming the count.
      * An assignment scope can hold tens of millions of rows, so instead of
        remembering keys the crawler asks the SOURCE for its distinct
        (principal, resource) count after the slot.
      * After the run, POST /ingest/count gives each scope's live rows that this
        run touched, counted in the database. Anything other than the expected
        count fails the job, with a table saying which scope and by how much.

    Contexts and identities have no systemId and cannot be counted per system;
    the context report in SqlCrawler.Contexts.ps1 covers the catalogue.
#>

#region Expectations

# Endpoints whose key set is small enough to hold in memory for an exact count.
$script:SqlKeyedEndpoints = @('ingest/principals', 'ingest/resources', 'ingest/resource-relationships')

# The expectation for one (endpoint, scope), created once however many slots feed it.
function Get-SqlExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Key, [Parameter(Mandatory)] [string]$Endpoint, [hashtable]$Scope = @{})
    if (-not $State.Expect.ContainsKey($Key)) {
        # Assigned, not `KeySet = if (…) { [HashSet]::new() }`: an if-expression
        # enumerates its output, and an EMPTY set enumerates to nothing — $null.
        $keySet = $null
        if ($Endpoint -in $script:SqlKeyedEndpoints) { $keySet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal) }
        $State.Expect[$Key] = @{
            # NOT "Keys": on a hashtable, .Keys is the dictionary's own key collection.
            Endpoint = $Endpoint; Scope = $Scope; Slots = 0
            Rows = [long]0
            KeySet = $keySet
            SourceDistinct = $null; Dangling = [long]0; Unverifiable = $null
        }
    }
    return $State.Expect[$Key]
}

# One record sent into a keyed scope.
function Add-SqlExpectedKey {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expectation, [Parameter(Mandatory)] [string]$Key)
    $Expectation.Rows++
    [void]$Expectation.KeySet.Add($Key)
}

# The statement's distinct (principal, resource) pairs, counted by SQL Server.
# A paged statement carries ORDER BY … OFFSET, which cannot be wrapped as a
# derived table, so it is reported as unverifiable rather than guessed at.
function Measure-SqlSourceDistinct {
    [CmdletBinding()]
    param([AllowNull()] $Connection, [Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$Map, [int]$CommandTimeout = 600)
    if ($Slot.paged) { return @{ count = $null; reason = 'the statement pages with @Offset' } }
    if ($null -eq $Connection) { return @{ count = $null; reason = 'there is no source connection' } }
    $p = if ($Map.principalId) { $Map.principalId } else { $Map.identityId }
    if (-not $Map.resourceId -or -not $p) { return @{ count = $null; reason = 'no rows were read' } }
    # A count that cannot run leaves the scope unverified; it never fails the load.
    $cmd = $null
    try {
        $cmd = $Connection.CreateCommand()
        $cmd.CommandText = "SELECT COUNT_BIG(*) FROM (SELECT DISTINCT q.[$($Map.resourceId -replace '\]', ']]')], q.[$($p -replace '\]', ']]')] FROM (`n$($Slot.sql)`n) q) d"
        $cmd.CommandTimeout = $CommandTimeout
        return @{ count = [long]$cmd.ExecuteScalar(); reason = $null }
    } catch {
        return @{ count = $null; reason = "the source count failed: $($_.Exception.GetBaseException().Message)" }
    } finally { if ($cmd) { $cmd.Dispose() } }
}

#endregion Expectations

#region Verdict

# One scope's verdict: what was expected, what the database holds, and whether
# that is a failure. Pure given the expectation and the database count.
function Get-SqlScopeVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expectation, [Parameter(Mandatory)] [long]$Atlas)
    $e = $Expectation
    if ($e.KeySet) {
        $distinct = [long]$e.KeySet.Count
        if ($e.Rows -gt $distinct) {
            return @{ ok = $false; expected = $distinct; atlas = $Atlas
                      reason = "the source returned $($e.Rows.ToString('N0')) rows for only $($distinct.ToString('N0')) distinct ids; rows sharing an id overwrite each other, so $(($e.Rows - $distinct).ToString('N0')) were lost. Make the id column unique" }
        }
        if ($Atlas -ne $distinct) { return @{ ok = $false; expected = $distinct; atlas = $Atlas; reason = 'the database holds a different number of rows than were sent' } }
        return @{ ok = $true; expected = $distinct; atlas = $Atlas; reason = $null }
    }
    if ($null -ne $e.Unverifiable) { return @{ ok = $true; expected = $null; atlas = $Atlas; reason = "not verified: $($e.Unverifiable)" } }
    # Distinct pairs the source holds, less rows held back as dangling (a dangling
    # row is never sent). Exact when nothing dangled and one slot fed the scope.
    $expected = [long]$e.SourceDistinct - $e.Dangling
    if ($e.Dangling -eq 0 -and $e.Slots -eq 1) {
        if ($Atlas -ne $expected) { return @{ ok = $false; expected = $expected; atlas = $Atlas; reason = 'the database holds a different number of distinct assignments than the source' } }
        return @{ ok = $true; expected = $expected; atlas = $Atlas; reason = $null }
    }
    # Dangling rows may repeat a pair, and two slots may overlap: a bound, not an equality.
    if ($Atlas -lt $expected -or $Atlas -gt [long]$e.SourceDistinct) {
        return @{ ok = $false; expected = $expected; atlas = $Atlas; reason = "outside the possible range $($expected.ToString('N0'))-$(([long]$e.SourceDistinct).ToString('N0'))" }
    }
    return @{ ok = $true; expected = $expected; atlas = $Atlas; reason = 'within range (dangling rows or overlapping statements make it inexact)' }
}

function Format-SqlScopeLabel {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Expectation)
    $scope = ($Expectation.Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
    return "$($Expectation.Endpoint -replace '^ingest/', '')$(if ($scope) { " ($scope)" })"
}

# Count every scope in the database and compare. Throws when any scope fails,
# after printing the whole table, so a partial load can never report success.
function Test-SqlRunCounts {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    if ($State.Expect.Count -eq 0) { return @() }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying: source against database..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Verifying counts' -Pct 93
    $results = foreach ($e in $State.Expect.Values) {
        $entity = $e.Endpoint -replace '^ingest/', ''
        $r = Invoke-IngestAPI -Endpoint 'ingest/count' -Body @{ entity = $entity; systemId = $State.SystemId; scope = $e.Scope; before = $State.ServerTime }
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas ([long]$r.count)
        $label = Format-SqlScopeLabel -Expectation $e
        $exp = if ($null -ne $v.expected) { $v.expected.ToString('N0') } else { '-' }
        $line = "  {0,-4} {1,-48} expected {2,12}  database {3,12}" -f $(if ($v.ok) { 'ok' } else { 'FAIL' }), $label, $exp, $v.atlas.ToString('N0')
        Write-Host $line -ForegroundColor $(if ($v.ok) { 'Gray' } else { 'Red' })
        if ($v.reason) { Write-Host "       $($v.reason)" -ForegroundColor $(if ($v.ok) { 'DarkGray' } else { 'Red' }) }
        [pscustomobject]@{ scope = $label; ok = $v.ok; expected = $v.expected; atlas = $v.atlas; reason = $v.reason }
    }
    $State.Verification = @($results)
    $failed = @($results | Where-Object { -not $_.ok })
    if ($failed.Count) {
        throw "Verification failed for $($failed.Count) of $(@($results).Count) scope(s): $(($failed | ForEach-Object { "$($_.scope): expected $($_.expected), database $($_.atlas)" }) -join '; ')"
    }
    return @($results)
}

#endregion Verdict
