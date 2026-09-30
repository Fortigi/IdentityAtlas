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
      * Around every statement the crawler asks the SOURCE how many rows the
        statement returns (Measure-SqlSource) — once BEFORE the read and once
        after — and the rows read must land inside the band those two counts
        describe. This is the check that sees a read which stopped early: every
        count below only knows what arrived. It was missing when a job read
        22,087 of 176,703 identities, all distinct, all landed, and verified
        perfectly.
      * An assignment scope can hold tens of millions of rows, so instead of
        remembering keys the same source query returns its distinct
        (principal, resource) count, in the same pass.
      * After the run, POST /ingest/count gives each scope's live rows that this
        run touched, counted in the database. Anything other than the expected
        count fails the job, with a table saying which scope and by how much.

    A SOURCE THAT MOVES. A large governance database is aggregated continuously;
    a read of it takes hours, and nothing freezes it meanwhile. Holding the read
    to a single count taken afterwards therefore failed every run against one:
    805,491 rows read of 805,547; 33,857,035 read of 33,841,580 (more than the
    table held minutes later — rows were deleted mid-read); 5,315,294 of
    5,325,064. Because the verification runs BEFORE Save-SqlWatermarks, one
    drifting statement meant no watermark was stored for any statement and the
    delta import could never establish a baseline.

    The fix is to ask the right question rather than to loosen the answer. The
    source is counted at both ends of the read, and a complete read must land
    between them, with the observed drift allowed as slack on either side — so a
    source that did not move is still held to exact equality, and a source that
    moved by N rows buys exactly N rows of tolerance. A flat percentage would
    have been the wrong trade: 1% also waves through a read that genuinely lost
    0.5% of its rows, and a verified run WRITES the watermark, so that loss would
    be stepped over permanently and invisibly on the next delta.

    Contexts and identities have no systemId and cannot be counted per system;
    the context report in SqlCrawler.Contexts.ps1 covers the catalogue.

    A PAIR IS NOT AN ID, which qualifies the first bullet above. "Rows > keys
    means rows were lost" holds only where the key names ONE record, as a
    resource's or a principal's externalId does. A relationship is keyed on
    (parent, child) and an assignment on (resource, principal): two source rows
    producing one such key are the same edge, and collapsing them loses nothing.
    Those scopes are therefore compared distinct-against-distinct, the way the
    unkeyed assignment path has always compared the source's own distinct pairs.
    See SqlPairKeyedEndpoints.
#>

#region Expectations

# Endpoints whose key set is small enough to hold in memory for an exact count.
$script:SqlKeyedEndpoints = @('ingest/principals', 'ingest/resources', 'ingest/resource-relationships')

# Endpoints whose key is a PAIR the data model already treats as unique — a
# relationship is (parent, child) and an assignment is (resource, principal) —
# rather than one id naming one record.
#
# The difference decides whether two source rows that produce the same key are a
# data-loss finding or a duplicate edge. For a resource or a principal, one id
# arriving twice means two DIFFERENT records collided and one silently replaced
# the other: real loss, and the check that catches it stays exactly as strict.
# For a pair, the two rows ARE the same edge — a business role can reference one
# entitlement through two source applications, and collapsing those is correct
# and idempotent, because an edge carries nothing but its two ends. Held to the
# id rule, a real run failed on
#   "the source returned 5,540 rows for only 5,534 distinct ids ... so 6 were
#    lost" while expected and database both read 5,534 —
# the scope agreed with itself perfectly and the job failed on the complaint
# alone. So a pair-keyed scope is compared distinct-against-distinct, which is
# what the unkeyed assignment path has always done with the source's own
# "distinct (principal, resource) pairs"; this gives the keyed ownership
# assignments and the relationships the same treatment rather than a second
# mechanism.
$script:SqlPairKeyedEndpoints = @('ingest/resource-relationships', 'ingest/resource-assignments')

# Is this scope keyed on a pair rather than on one record's id?
function Test-SqlPairKeyedEndpoint {
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowNull()] [AllowEmptyString()] [string]$Endpoint)
    return $Endpoint -in $script:SqlPairKeyedEndpoints
}

# The expectation for one (endpoint, scope), created once however many slots feed it.
function Get-SqlExpectation {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] [string]$Key, [Parameter(Mandatory)] [string]$Endpoint, [hashtable]$Scope = @{}, [switch]$Keyed)
    if (-not $State.Expect.ContainsKey($Key)) {
        # Assigned, not `KeySet = if (…) { [HashSet]::new() }`: an if-expression
        # enumerates its output, and an EMPTY set enumerates to nothing — $null.
        #
        # -Keyed forces a key set on an endpoint that normally has none. An
        # assignment scope is unkeyed because it can hold tens of millions of
        # rows and its expectation comes from the source's own distinct-pair
        # count instead — but an OWNER assignment has no statement of its own to
        # count, one per owned resource at most, so it is both affordable to
        # remember and unverifiable any other way. Without this it would expect
        # zero and fail every run that emitted one.
        $keySet = $null
        if ($Keyed -or $Endpoint -in $script:SqlKeyedEndpoints) { $keySet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal) }
        $State.Expect[$Key] = @{
            # NOT "Keys": on a hashtable, .Keys is the dictionary's own key collection.
            Endpoint = $Endpoint; Scope = $Scope; Slots = 0
            Rows = [long]0
            KeySet = $keySet
            # The systems this scope was written to. The source's own counts are
            # per statement, never per system, so the database side has to be
            # summed over exactly the systems the run fed — one of them alone
            # would read as a shortfall the moment anything is routed.
            Systems = [System.Collections.Generic.HashSet[int]]::new()
            SourceDistinct = $null; Dangling = [long]0; Unverifiable = $null
            # How far the source moved under the statements feeding this scope,
            # summed. The distinct-pair count is measured once, after the read,
            # and a pair count cannot have moved by more than the ROW count did
            # — one inserted or deleted row changes at most one pair — so the
            # row drift is this count's tolerance too, for free. Measuring it
            # directly would mean a second GROUP BY over tens of millions of rows.
            Drift = [long]0
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

# What SQL Server says the statement returns: its row count and, for an
# assignment statement, its distinct (principal, resource) pairs, both from ONE
# pass (a GROUP BY whose groups are the pairs and whose sizes sum to the rows),
# so a 40-million-row statement is scanned once more, not twice. The row count
# is what catches a read that stopped early: the crawler's own tallies only know
# what arrived. A paged statement carries ORDER BY … OFFSET, which cannot be
# wrapped as a derived table, so it is reported as unverifiable rather than
# guessed at.
#
# -RowsOnly is the count taken BEFORE the read. Only the row count is wanted
# there — the pair count is needed once, and the GROUP BY is the expensive half:
# measured on the rehearsal fixture, 3.0 s for the rows against 4.8 s for rows
# and pairs over the same 3.2 M-row statement.
function Get-SqlSourceCountSql {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot, [AllowNull()] [hashtable]$Map, [switch]$RowsOnly)
    $inner = "(`n$($Slot.sql)`n) q"
    $p = if ($Map.principalId) { $Map.principalId } else { $Map.identityId }
    if ($RowsOnly -or $Slot.target -ne 'assignments' -or -not $Map.resourceId -or -not $p) { return "SELECT COUNT_BIG(*), NULL FROM $inner" }
    return "SELECT COALESCE(SUM(g.n), 0), COUNT_BIG(*) FROM (SELECT COUNT_BIG(*) AS n FROM $inner GROUP BY q.[$($Map.resourceId -replace '\]', ']]')], q.[$($p -replace '\]', ']]')]) g"
}

function Measure-SqlSource {
    [CmdletBinding()]
    param([AllowNull()] $Connection, [Parameter(Mandatory)] [hashtable]$Slot, [AllowNull()] [hashtable]$Map,
          [int]$CommandTimeout = 600, [AllowNull()] $Since = $null, [switch]$RowsOnly)
    if ($Slot.paged) { return @{ rows = $null; pairs = $null; reason = 'the statement pages with @Offset' } }
    if ($null -eq $Connection) { return @{ rows = $null; pairs = $null; reason = 'there is no source connection' } }
    # A count that cannot run leaves the slot unverified; it never fails the load.
    # The reader stays inside this function: see "NEVER PASS THE READER".
    $cmd = $null; $reader = $null
    try {
        # The window the count asks about must be the window the read asked
        # about: a windowed statement counted with @Since unbound is a syntax
        # error, and counted from zero is the whole table against a window's
        # rows — a verification that fails every delta run.
        $cmd = New-SqlCommand -Connection $Connection -Sql (Get-SqlSourceCountSql -Slot $Slot -Map $Map -RowsOnly:$RowsOnly) `
            -CommandTimeout $CommandTimeout -Since $Since
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

# The window the counts ask about must be the window the read asked about. Read
# once, from the delta state the slot started with, so both ends of the band and
# the read itself are bound to the same @Since.
function Get-SqlCountWindow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx)
    if ($Ctx.Delta) { return $Ctx.Delta.Since }
    return $null
}

# BEFORE the statement runs: how many rows the source held when the read started.
# Half of the band a moving source is judged against; $null when there is nothing
# to count against (a paged statement, no connection) or the count failed, in
# which case the read falls back to the single count taken afterwards.
function Get-SqlSourceRowsBefore {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [AllowNull()] $Connection)
    # Map is resolved from the first row, so it does not exist yet — which costs
    # nothing, because -RowsOnly does not use it.
    if ($null -eq $Connection -or $Ctx.Slot.paged) { return $null }
    $m = Measure-SqlSource -Connection $Connection -Slot $Ctx.Slot -Map $null `
        -CommandTimeout $Ctx.State.CommandTimeout -Since (Get-SqlCountWindow -Ctx $Ctx) -RowsOnly
    if ($null -eq $m.rows) {
        Write-Host "  the source could not be counted before the read ($($m.reason)); the read will be held to the single count taken afterwards" -ForegroundColor Yellow
        return $null
    }
    Write-Host "  source holds $($m.rows.ToString('N0')) rows before the read" -ForegroundColor DarkGray
    return $m.rows
}

# After each statement: measure the source again, record whether the read was
# complete, and give an assignment scope its expectation from the same answer.
function Add-SqlReadCheck {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Ctx, [AllowNull()] $Connection, [long]$Rows = 0)
    $m = Measure-SqlSource -Connection $Connection -Slot $Ctx.Slot -Map $Ctx.Map -CommandTimeout $Ctx.State.CommandTimeout -Since (Get-SqlCountWindow -Ctx $Ctx)
    $Ctx.State.Reads.Add(@{ Slot = $Ctx.Slot.name; Read = $Rows; Before = $Ctx.SourceBefore; Source = $m.rows; Reason = $m.reason
                            Unplaced = [long]($Ctx.Dangling + $Ctx.Skipped); Misrouted = [long]$Ctx.Misrouted })
    if ($null -ne $m.rows) {
        $pairs = if ($null -ne $m.pairs) { ", $($m.pairs.ToString('N0')) distinct (principal, resource) pairs" }
        Write-Host "  source returns $($m.rows.ToString('N0')) rows$pairs" -ForegroundColor DarkGray
    }
    # Always reported, pass or fail: how far the source moved under the read is a
    # finding about the source, not only an input to the verdict.
    $band = Get-SqlReadBand -Before $Ctx.SourceBefore -After $m.rows
    if ($band -and $band.Moving) {
        Write-Host "  the source moved by $($band.Drift.ToString('N0')) rows during the read ($(([long]$Ctx.SourceBefore).ToString('N0')) → $(([long]$m.rows).ToString('N0')))" -ForegroundColor DarkGray
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
    # See Drift in Get-SqlExpectation: the row drift bounds how far the pair
    # count can have moved between the read and the single pass that counted it.
    $band = Get-SqlReadBand -Before $Ctx.SourceBefore -After $Measure.rows
    if ($band) { $expect.Drift += $band.Drift }
}

#endregion Expectations

#region Verdict

# A scope small enough to have remembered its keys. Both sides of this
# comparison are the crawler's OWN: the distinct keys it sent against the rows
# the database now holds. A moving source cannot explain a difference here, so
# nothing about drift belongs in it — it stays exact.
#
# What a REPEATED key means depends on what the key is, which is the whole of
# SqlPairKeyedEndpoints: one id naming one record means a genuine overwrite,
# while a pair naming an edge means the same edge arrived twice.
function Get-SqlKeyedScopeVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expectation, [Parameter(Mandatory)] [long]$Atlas)
    $e = $Expectation
    $distinct = [long]$e.KeySet.Count
    $collapsed = [long]$e.Rows - $distinct
    if ($collapsed -gt 0 -and -not (Test-SqlPairKeyedEndpoint -Endpoint $e.Endpoint)) {
        return @{ ok = $false; expected = $distinct; atlas = $Atlas
                  reason = "the source returned $($e.Rows.ToString('N0')) rows for only $($distinct.ToString('N0')) distinct ids; rows sharing an id overwrite each other, so $($collapsed.ToString('N0')) were lost. Make the id column unique" }
    }
    if ($Atlas -ne $distinct) { return @{ ok = $false; expected = $distinct; atlas = $Atlas; reason = 'the database holds a different number of rows than were sent' } }
    # Worth saying even though it passes: a statement producing the same edge
    # twice is usually a join fanning out, which is harmless here but is the
    # first thing to look at if the numbers ever surprise someone.
    return @{ ok = $true; expected = $distinct; atlas = $Atlas
              reason = $(if ($collapsed -gt 0) { "$($e.Rows.ToString('N0')) source rows collapsed to $($distinct.ToString('N0')) distinct pairs; a repeated pair is the same edge, so nothing was lost" }) }
}

# One scope's verdict: what was expected, what the database holds, and whether
# that is a failure. Pure given the expectation and the database count.
function Get-SqlScopeVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Expectation, [Parameter(Mandatory)] [long]$Atlas)
    $e = $Expectation
    if ($e.KeySet) { return Get-SqlKeyedScopeVerdict -Expectation $e -Atlas $Atlas }
    if ($null -ne $e.Unverifiable) { return @{ ok = $true; expected = $null; atlas = $Atlas; reason = "not verified: $($e.Unverifiable)" } }
    # Distinct pairs the source holds, less rows held back as dangling (a dangling
    # row is never sent). Exact when nothing dangled and one slot fed the scope —
    # and when the source did not move under the read. It did in the field, and
    # the same drift that made the read check fail made this one fail too
    # ("expected 5,325,064, database 5,315,294"), so the pair count carries the
    # same slack: see Drift in Get-SqlExpectation.
    $drift = [long]$e.Drift
    $moved = if ($drift -gt 0) { "; the source moved by $($drift.ToString('N0')) rows while it was read, which is the slack allowed here" }
    $expected = [long]$e.SourceDistinct - $e.Dangling
    if ($e.Dangling -eq 0 -and $e.Slots -eq 1) {
        if ([Math]::Abs($Atlas - $expected) -gt $drift) {
            return @{ ok = $false; expected = $expected; atlas = $Atlas; reason = "the database holds a different number of distinct assignments than the source$moved" }
        }
        return @{ ok = $true; expected = $expected; atlas = $Atlas; reason = $(if ($drift -gt 0) { "within the drift the source showed while it was read ($($drift.ToString('N0')) rows)" }) }
    }
    # Dangling rows may repeat a pair, and two slots may overlap: a bound, not an equality.
    if ($Atlas -lt $expected - $drift -or $Atlas -gt [long]$e.SourceDistinct + $drift) {
        return @{ ok = $false; expected = $expected; atlas = $Atlas; reason = "outside the possible range $(($expected - $drift).ToString('N0'))-$((([long]$e.SourceDistinct) + $drift).ToString('N0'))$moved" }
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
#
# A row naming a system no `systems` statement created is held to the same
# bound. It is never dropped — the row lands in the crawler's own system, which
# is what the CSV crawler does — but it IS wrong, and above a rounding error it
# means the systems statement and this one disagree about which connectors
# exist. The CSV crawler's silent version of this was a reported defect; the
# quiet fallback plus a warning is the floor, and this is the ceiling.
$script:SqlMaxUnplacedShare = 0.05

# The range a complete read may land in, from the source counted at both ends of
# it. $null when the source could not be counted at all.
#
# Without a count from before the read there is only one number, so the band is
# that number twice and the comparison is the exact equality it always was.
#
# With both, the read may land anywhere between them — and the observed drift is
# allowed as slack on either side as well. That slack is not a tolerance handed
# out in advance; it is the source's own measured movement. A source that did
# not move gets none, and is held to exact equality exactly as before. A source
# that moved by N rows gets N, which is what makes the two ends a band rather
# than two numbers that must both be hit: under READ COMMITTED a read lasting
# hours may miss a row deleted while it ran and see one inserted and deleted
# again, neither of which the endpoints record. The residual is honest and
# stated: a source churning by N rows makes this check blind to a loss of up to
# ~N rows, which is why the drift is printed on every run whether or not it
# passes. It cannot hide the failure this check exists for — the shipped defect
# lost 87.5% of its rows.
function Get-SqlReadBand {
    [CmdletBinding()]
    param([AllowNull()] $Before, [AllowNull()] $After)
    if ($null -eq $After) { return $null }
    $a = [long]$After
    if ($null -eq $Before) { return @{ Lo = $a; Hi = $a; Drift = [long]0; Moving = $false } }
    $b = [long]$Before
    $drift = [long][Math]::Abs($a - $b)
    return @{ Lo = [long]([Math]::Min($a, $b) - $drift); Hi = [long]([Math]::Max($a, $b) + $drift)
              Drift = $drift; Moving = ($drift -gt 0) }
}

# How the band is described in the verdict table.
function Format-SqlReadBand {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Read, [Parameter(Mandatory)] [hashtable]$Band)
    if (-not $Band.Moving) { return "the source returns $($Band.Hi.ToString('N0')) rows" }
    return ("the source held $(([long]$Read.Before).ToString('N0')) rows before the read and " +
            "$(([long]$Read.Source).ToString('N0')) after — it moved by $($Band.Drift.ToString('N0')) during the read, " +
            "so a complete read is $($Band.Lo.ToString('N0'))-$($Band.Hi.ToString('N0')) rows")
}

function Get-SqlReadVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Read)
    $unplaced = [long]$Read.Unplaced
    if ($Read.Read -gt 0 -and $unplaced / $Read.Read -gt $script:SqlMaxUnplacedShare) {
        return @{ ok = $false
                  reason = "$($unplaced.ToString('N0')) of the $($Read.Read.ToString('N0')) rows read ($([Math]::Round(100 * $unplaced / $Read.Read, 1))%) could not be placed: they name a resource or principal this run did not load, or lack a required column. The statements disagree about what exists, e.g. one filters rows another does not" }
    }
    $misrouted = [long]$Read.Misrouted
    if ($Read.Read -gt 0 -and $misrouted / $Read.Read -gt $script:SqlMaxUnplacedShare) {
        return @{ ok = $false
                  reason = "$($misrouted.ToString('N0')) of the $($Read.Read.ToString('N0')) rows read ($([Math]::Round(100 * $misrouted / $Read.Read, 1))%) name a system no 'systems' statement created, and were loaded into the crawler's own system instead. Either the systems statement is filtered more narrowly than this one, or the two name a connector differently" }
    }
    $band = Get-SqlReadBand -Before $Read.Before -After $Read.Source
    if ($null -eq $band) { return @{ ok = $true; reason = "not verified: $($Read.Reason)" } }
    if ($Read.Read -ge $band.Lo -and $Read.Read -le $band.Hi) {
        # A moving source is worth saying out loud even when it passes.
        return @{ ok = $true; reason = $(if ($band.Moving) { Format-SqlReadBand -Read $Read -Band $band }) }
    }
    $short = if ($Read.Read -lt $band.Lo) { 'The read stopped early' } else { 'The read returned more rows than the source ever held' }
    return @{ ok = $false
              reason = "the crawler read $($Read.Read.ToString('N0')) rows; $(Format-SqlReadBand -Read $Read -Band $band). $short. A partial read cannot be told apart from a finished one by the rows alone, so the run is not verified and no watermark is stored" }
}

function Format-SqlScopeLabel {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] $Expectation)
    $scope = ($Expectation.Scope.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
    $n = if ($Expectation.Systems) { $Expectation.Systems.Count } else { 0 }
    $across = if ($n -gt 1) { " ×$n systems" } else { '' }
    return "$($Expectation.Endpoint -replace '^ingest/', '')$(if ($scope) { " ($scope)" })$across"
}

# What the database holds for one expectation: its rows in every system the run
# wrote this scope to, counted since the run's own start.
#
# -Before overrides that start. A key sweep read the source's COMPLETE key set,
# so after it the scope's TOTAL is comparable, not just the part this run
# touched; passing a date before any row is how that total is asked for.
function Measure-SqlScopeRows {
    [CmdletBinding()]
    [OutputType([long])]
    param([Parameter(Mandatory)] [hashtable]$State, [Parameter(Mandatory)] $Expectation, [string]$Before = '')
    $entity = $Expectation.Endpoint -replace '^ingest/', ''
    # A staged scope is counted whole (SqlCrawler.Staging.ps1).
    $since  = if ($Before) { $Before } elseif ($Expectation.Whole) { $script:SqlBeginningOfTime } else { $State.ServerTime }
    $systems = @($Expectation.Systems)
    if ($systems.Count -eq 0) { $systems = @($State.SystemId) }
    [long]$total = 0
    foreach ($sid in $systems) {
        $r = Invoke-IngestAPI -Endpoint 'ingest/count' -Body @{ entity = $entity; systemId = $sid; scope = $Expectation.Scope; before = $since }
        $total += [long]$r.count
    }
    return $total
}

# Before any row this product has ever written — "count the whole scope".
$script:SqlBeginningOfTime = '1970-01-01T00:00:00.000Z'

# An external id that two systems both claimed. Both hash to one row in the
# run's single id namespace, so one silently replaced the other — the same loss
# as two source rows sharing an id, one level up. Returns a verdict or $null.
function Get-SqlIdCollisionVerdict {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Catalog)
    if ($Catalog.CollisionRows -le 0) { return $null }
    $sample = @($Catalog.Collisions.GetEnumerator() | ForEach-Object { "'$($_.Key)' in systems $($_.Value)" }) -join '; '
    return @{ ok = $false; expected = [long]0; atlas = [long]$Catalog.CollisionRows
              reason = "$($Catalog.CollisionRows.ToString('N0')) external id(s) were claimed by more than one system. Ids are unique per RUN, not per system, so these rows overwrite each other and one of the two is lost: $sample" }
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
    if ($State.Expect.Count -eq 0 -and $State.Reads.Count -eq 0 -and -not $State.Sweeps) { return @() }
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Verifying: source against database..." -ForegroundColor Cyan
    Update-CrawlerProgress -Step 'Verifying counts' -Pct 93
    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($read in $State.Reads) {
        $results.Add((Write-SqlVerdictLine -Label "read: $($read.Slot)" -Verdict (Get-SqlReadVerdict -Read $read) -Expected $read.Source -Actual $read.Read -Measured 'read'))
    }
    foreach ($e in $State.Expect.Values) {
        $v = Get-SqlScopeVerdict -Expectation $e -Atlas (Measure-SqlScopeRows -State $State -Expectation $e)
        $results.Add((Write-SqlVerdictLine -Label (Format-SqlScopeLabel -Expectation $e) -Verdict $v -Expected $v.expected -Actual $v.atlas))
    }
    # A swept scope is the one place a TOTAL can be asserted rather than just
    # the part this run touched — the sweep read the source's whole key set.
    if ($State.Sweeps) { foreach ($r in (Test-SqlSweepTotals -State $State)) { $results.Add($r) } }
    $collision = Get-SqlIdCollisionVerdict -Catalog $State.Systems
    if ($collision) {
        $results.Add((Write-SqlVerdictLine -Label 'external ids unique across systems' -Verdict $collision -Expected 0 -Actual $collision.atlas -Measured 'collisions'))
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
