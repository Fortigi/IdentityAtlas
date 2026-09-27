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
      * After every statement the crawler asks the SOURCE how many rows the
        statement returns (Measure-SqlSource). Rows read must equal it. This is
        the check that sees a read which stopped early: every count below only
        knows what arrived. It was missing when a job read 22,087 of 176,703
        identities, all distinct, all landed, and verified perfectly.
      * An assignment scope can hold tens of millions of rows, so instead of
        remembering keys the same source query returns its distinct
        (principal, resource) count, in the same pass.
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

# What SQL Server says the statement returns, asked after the read: its row
# count and, for an assignment statement, its distinct (principal, resource)
# pairs, both from ONE pass (a GROUP BY whose groups are the pairs and whose
# sizes sum to the rows), so a 40-million-row statement is scanned once more,
# not twice. The row count is what catches a read that stopped early: the
# crawler's own tallies only know what arrived. A paged statement carries
# ORDER BY … OFFSET, which cannot be wrapped as a derived table, so it is
# reported as unverifiable rather than guessed at.
function Get-SqlSourceCountSql {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot, [AllowNull()] [hashtable]$Map)
    $inner = "(`n$($Slot.sql)`n) q"
    $p = if ($Map.principalId) { $Map.principalId } else { $Map.identityId }
    if ($Slot.target -ne 'assignments' -or -not $Map.resourceId -or -not $p) { return "SELECT COUNT_BIG(*), NULL FROM $inner" }
    return "SELECT COALESCE(SUM(g.n), 0), COUNT_BIG(*) FROM (SELECT COUNT_BIG(*) AS n FROM $inner GROUP BY q.[$($Map.resourceId -replace '\]', ']]')], q.[$($p -replace '\]', ']]')]) g"
}

function Measure-SqlSource {
    [CmdletBinding()]
    param([AllowNull()] $Connection, [Parameter(Mandatory)] [hashtable]$Slot, [AllowNull()] [hashtable]$Map, [int]$CommandTimeout = 600)
    if ($Slot.paged) { return @{ rows = $null; pairs = $null; reason = 'the statement pages with @Offset' } }
    if ($null -eq $Connection) { return @{ rows = $null; pairs = $null; reason = 'there is no source connection' } }
    # A count that cannot run leaves the slot unverified; it never fails the load.
    # The reader stays inside this function: see "NEVER PASS THE READER".
    $cmd = $null; $reader = $null
    try {
        $cmd = $Connection.CreateCommand()
        $cmd.CommandText = Get-SqlSourceCountSql -Slot $Slot -Map $Map
        $cmd.CommandTimeout = $CommandTimeout
        $reader = $cmd.ExecuteReader()
        [void]$reader.Read()
        $pairs = $reader.GetValue(1)
        return @{ rows = [long]$reader.GetValue(0); pairs = $(if ($pairs -is [System.DBNull] -or $null -eq $pairs) { $null } else { [long]$pairs }); reason = $null }
    } catch {
        return @{ rows = $null; pairs = $null; reason = "the source count failed: $($_.Exception.GetBaseException().Message)" }
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($cmd) { $cmd.Dispose() }
    }
}

# After each statement: measure the source once, record whether the read was
# complete, and give an assignment scope its expectation from the same answer.
function Add-SqlReadCheck {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [AllowNull()] $Connection, [long]$Rows = 0)
    $m = Measure-SqlSource -Connection $Connection -Slot $Ctx.Slot -Map $Ctx.Map -CommandTimeout $Ctx.State.CommandTimeout
    $Ctx.State.Reads.Add(@{ Slot = $Ctx.Slot.name; Read = $Rows; Source = $m.rows; Reason = $m.reason; Unplaced = [long]($Ctx.Dangling + $Ctx.Skipped) })
    if ($null -ne $m.rows) {
        $pairs = if ($null -ne $m.pairs) { ", $($m.pairs.ToString('N0')) distinct (principal, resource) pairs" }
        Write-Host "  source returns $($m.rows.ToString('N0')) rows$pairs" -ForegroundColor DarkGray
    }
    if ($Ctx.Slot.target -eq 'assignments') { Add-SqlAssignmentExpectation -Ctx $Ctx -Measure $m -Rows $Rows }
}

# An assignment scope is too large to remember keys for; its expectation is the
# source's own distinct (principal, resource) count, less what was held back.
function Add-SqlAssignmentExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [Parameter(Mandatory)] [hashtable]$Measure, [long]$Rows = 0)
    $expect = $Ctx.Streams.assignment.Expect
    $expect.Dangling += $Ctx.Dangling
    # Nothing arrived: the scope expects nothing. Whether the source agrees is the
    # read check's question, not this one's.
    if ($Rows -eq 0) { $expect.SourceDistinct = [long]$expect.SourceDistinct; return }
    if ($null -eq $Measure.pairs) { $expect.Unverifiable = $Measure.reason; return }
    $expect.SourceDistinct = [long]$expect.SourceDistinct + $Measure.pairs
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

# One statement's read against what the source returns. The database counts
# above cannot see a read that stopped early: 22,087 rows that all arrive, all
# distinct, all land, verify perfectly against themselves. Pure.
# The share of a statement's rows that may arrive and still not be placed: held
# back as dangling (they name a resource or principal the run did not load) or
# skipped (a required column is empty). A little is normal, e.g. grants held by
# workgroups a principals statement leaves out. More means the statements disagree
# about what exists: an entitlement statement filtered on type = 'Entitlement'
# loaded 454 of 805,497 rows, every grant for the rest dangled, and the run passed,
# because a dangling row used to be a footnote and made the assignment count an
# unbounded "range". This bound is what makes that range an assertion.
$script:SqlMaxUnplacedShare = 0.05

function Get-SqlReadVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Read)
    $unplaced = [long]$Read.Unplaced
    if ($Read.Read -gt 0 -and $unplaced / $Read.Read -gt $script:SqlMaxUnplacedShare) {
        return @{ ok = $false
                  reason = "$($unplaced.ToString('N0')) of the $($Read.Read.ToString('N0')) rows read ($([Math]::Round(100 * $unplaced / $Read.Read, 1))%) could not be placed: they name a resource or principal this run did not load, or lack a required column. The statements disagree about what exists, e.g. one filters rows another does not" }
    }
    if ($null -eq $Read.Source) { return @{ ok = $true; reason = "not verified: $($Read.Reason)" } }
    if ($Read.Read -eq $Read.Source) { return @{ ok = $true; reason = $null } }
    return @{ ok = $false
              reason = "the crawler read $($Read.Read.ToString('N0')) rows but the source returns $(([long]$Read.Source).ToString('N0')). Either the read stopped early or the source changed during the run; a partial read cannot be told apart from a finished one by the rows alone" }
}

function Format-SqlScopeLabel {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Expectation)
    $scope = ($Expectation.Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
    return "$($Expectation.Endpoint -replace '^ingest/', '')$(if ($scope) { " ($scope)" })"
}

# One line of the verification table, printed and returned as a result row.
# $Measured names what $Actual is: 'database' for a scope, 'read' for a statement.
function Write-SqlVerdictLine {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string]$Label, [Parameter(Mandatory)] [hashtable]$Verdict, [AllowNull()] $Expected, [long]$Actual, [string]$Measured = 'database')
    $v = $Verdict
    $exp = if ($null -ne $Expected) { ([long]$Expected).ToString('N0') } else { '-' }
    $line = "  {0,-4} {1,-48} expected {2,12}  {3,-8} {4,12}" -f $(if ($v.ok) { 'ok' } else { 'FAIL' }), $Label, $exp, $Measured, $Actual.ToString('N0')
    Write-Host $line -ForegroundColor $(if ($v.ok) { 'Gray' } else { 'Red' })
    if ($v.reason) { Write-Host "       $($v.reason)" -ForegroundColor $(if ($v.ok) { 'DarkGray' } else { 'Red' }) }
    return [pscustomobject]@{ scope = $Label; ok = $v.ok; expected = $Expected; atlas = $Actual; measured = $Measured; reason = $v.reason }
}

# Check every statement's read against the source, then count every scope in the
# database and compare. Throws when anything fails, after printing the whole
# table, so a partial load can never report success.
function Test-SqlRunCounts {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State)
    if ($State.Expect.Count -eq 0 -and $State.Reads.Count -eq 0) { return @() }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying: source against database..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Verifying counts' -Pct 93
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($read in $State.Reads) {
        $results.Add((Write-SqlVerdictLine -Label "read: $($read.Slot)" -Verdict (Get-SqlReadVerdict -Read $read) -Expected $read.Source -Actual $read.Read -Measured 'read'))
    }
    foreach ($e in $State.Expect.Values) {
        $entity = $e.Endpoint -replace '^ingest/', ''
        $r = Invoke-IngestAPI -Endpoint 'ingest/count' -Body @{ entity = $entity; systemId = $State.SystemId; scope = $e.Scope; before = $State.ServerTime }
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas ([long]$r.count)
        $results.Add((Write-SqlVerdictLine -Label (Format-SqlScopeLabel -Expectation $e) -Verdict $v -Expected $v.expected -Actual $v.atlas))
    }
    $results = $results.ToArray()
    $State.Verification = $results
    $failed = @($results | Where-Object { -not $_.ok })
    if ($failed.Count) {
        throw "Verification failed for $($failed.Count) of $($results.Count) check(s): $(($failed | ForEach-Object { "$($_.scope): expected $($_.expected), $($_.measured) $($_.atlas)" }) -join '; ')"
    }
    return $results
}

#endregion Verdict
