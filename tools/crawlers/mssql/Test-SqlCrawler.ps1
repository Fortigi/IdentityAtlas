<#
.SYNOPSIS
    CI integration test for the SQL Database crawler.

.DESCRIPTION
    CI has no SQL Server, so the SQL boundary — and only that boundary — is
    replaced: Invoke-SqlQueryStream replays canned rows through the crawler's own
    per-row callback, exactly as a SqlDataReader would. Everything downstream is
    the real thing, including the LIVE Ingest API: the system registration, the
    streamed delta chunks, the deterministic-id references between statements,
    and the timestamp reconcile all go over HTTP to the running stack.

    What it proves that the unit tests cannot: the records this crawler shapes
    are accepted by the real ingest validation, the external-id references
    resolve across endpoints, and POST /ingest/reconcile removes exactly the rows
    the run did not touch (and nothing else).

.PARAMETER ApiBaseUrl
    e.g. http://localhost:3001/api
.PARAMETER ApiKey
    Built-in worker API key (fgc_...).
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey
)

$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')
$JobId = 0
$script:failures = 0

. (Join-Path $PSScriptRoot 'SqlCrawler.Load.ps1')

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "    $status  $Name  $Detail" -ForegroundColor $(if ($Passed) { 'Green' } else { 'Red' })
    if (-not $Passed) { $script:failures++ }
}

function Invoke-Api {
    param([string]$Path, [string]$Method = 'Get', $Body)
    $p = @{ Uri = "$ApiBaseUrl$Path"; Method = $Method; Headers = @{ Authorization = "Bearer $ApiKey" }; ContentType = 'application/json'; TimeoutSec = 60 }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10) }
    return Invoke-RestMethod @p
}

function New-TestRow { param([hashtable]$Cells) $o = [ordered]@{}; foreach ($k in $Cells.Keys) { $o[$k] = $Cells[$k] }; return $o }

# Replace ONLY the SQL boundary: each slot's rows are replayed through the
# crawler's real callback by name.
$script:RowsBySlot = @{}
# What each replayed statement was asked for: the window it bound, so the delta
# scenarios can assert the crawler read from the mark it stored.
$script:SinceBySlot = @{}
function Invoke-SqlQueryStream {
    [CmdletBinding()]
    param($Connection, [string]$Sql, [scriptblock]$OnRow, [int]$CommandTimeout = 600, [bool]$Paged = $false, [int]$PageSize = 10000, $Since = $null,
          [hashtable]$Timing)
    $script:SinceBySlot[$Sql] = $Since
    # A windowed statement replays only the rows past the mark it was given, the
    # way the source's own WHERE clause would. The key sweep wraps a statement in
    # SELECT DISTINCT … FROM (…) q, so an unknown text is resolved back to the
    # statement it wraps.
    $key = if ($script:RowsBySlot.ContainsKey($Sql)) { $Sql } else { @($script:RowsBySlot.Keys | Where-Object { $Sql.Contains($_) })[0] }
    $rows = @($script:RowsBySlot[$key])
    if ($null -ne $Since -and [long]$Since -gt 0) {
        $rows = @($rows | Where-Object { $null -eq $_['modified'] -or [long]$_['modified'] -ge [long]$Since })
    }
    foreach ($r in $rows) { & $OnRow $r }
    return [long]$rows.Count
}

# The sweep asks SQL Server to describe the statement's columns without running
# it. Off a live connection that is a dynamic-management function; here the
# replayed rows already say what the columns are.
function Get-SqlSweepResultColumns {
    [CmdletBinding()]
    param($Connection, [hashtable]$Slot, [int]$CommandTimeout = 600)
    $first = @($script:RowsBySlot[$Slot.sql])[0]
    if (-not $first) { return $null }
    return [string[]]@($first.Keys)
}

# The source-side counts, answered from what the SOURCE holds: the replayed rows,
# unless a scenario says the source holds more than the reader delivers.
#
# -RowsOnly is the count taken BEFORE the read, so a scenario that wants a source
# which MOVED while it was read answers that one from $script:SourceRowsBeforeBySlot
# and the one after the read from the two above.
$script:SourceRowsBySlot = @{}
$script:SourceRowsBeforeBySlot = @{}
function Measure-SqlSource {
    [CmdletBinding()]
    param($Connection, [hashtable]$Slot, [hashtable]$Map, [int]$CommandTimeout = 600, $Since = $null, [switch]$RowsOnly)
    # @() around the whole if: an if-expression unrolls a one-row array into the row itself.
    $rows = @(if ($RowsOnly -and $script:SourceRowsBeforeBySlot.ContainsKey($Slot.sql)) { $script:SourceRowsBeforeBySlot[$Slot.sql] }
              elseif ($script:SourceRowsBySlot.ContainsKey($Slot.sql)) { $script:SourceRowsBySlot[$Slot.sql] }
              else { $script:RowsBySlot[$Slot.sql] })
    # The count has to ask about the same window the read asked about, or every
    # delta run fails verification against the whole table.
    if ($null -ne $Since -and [long]$Since -gt 0) {
        $rows = @($rows | Where-Object { $null -eq $_['modified'] -or [long]$_['modified'] -ge [long]$Since })
    }
    $pairs = $null
    if ($Slot.target -eq 'assignments' -and $Map) { $pairs = [long]@($rows | ForEach-Object { "$($_[$Map.resourceId])|$($_[$Map.principalId])" } | Sort-Object -Unique).Count }
    return @{ rows = [long]$rows.Count; pairs = $pairs; reason = $null }
}

# End-of-run verification against the REAL /ingest/count. Returns $true when it
# passed, $false when it threw (which is what fails a real job).
function Test-Verified {
    param([hashtable]$State)
    try { Test-SqlRunCounts -State $State | Out-Null; return $true }
    catch { Write-Host "    ($($_.Exception.Message))" -ForegroundColor DarkGray; return $false }
}

Write-Host "`n=== SQL crawler integration test ===" -ForegroundColor Cyan

$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$cfg = @{ server = "sqltest-$runId"; database = 'iiq'; configName = "SQL crawler test $runId"; systemName = '' }

# ── Run 1: twelve entitlements, two identities, 24 grants plus one dangling ──
# One held-back grant in 25 (4%) stays under the verification's 5% unplaced bound.
$sqlIdent = 'SELECT identities'; $sqlRes = 'SELECT resources'; $sqlAsgn = 'SELECT assignments'; $sqlRel = 'SELECT relationships'
$slots = @(
    (Resolve-SqlQuerySlot -Slot @{ name = 'Identities';  target = 'identities';    sql = $sqlIdent }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Entitlements'; target = 'resources';    sql = $sqlRes;  resourceType = 'Entitlement' }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Grants';       target = 'assignments';  sql = $sqlAsgn; resourceType = 'Entitlement' }),
    # Deliberately UNALIASED, mapped instead — the operator's own SQL used verbatim.
    (Resolve-SqlQuerySlot -Slot @{ name = 'Composition'; target = 'relationships'; sql = $sqlRel
        columnMap = @{ RoleID = 'parentId'; EntitlementID = 'childId' } })
)
$script:RowsBySlot[$sqlIdent] = @(
    (New-TestRow @{ id = "u1-$runId"; display_name = 'Ann Tester'; email = "ann-$runId@test.local"; inactive = 0; costcenter = 'CC1' })
    (New-TestRow @{ id = "u2-$runId"; display_name = 'Bob Tester'; inactive = 1 })
)
$script:RowsBySlot[$sqlRes] = @(
    (New-TestRow @{ id = "e1-$runId"; name = 'AD-Sales' })
    (New-TestRow @{ id = "e2-$runId"; name = 'AD-Finance' })
    foreach ($n in 3..12) { New-TestRow @{ id = "e$n-$runId"; name = "AD-Group-$n" } }
)
$script:RowsBySlot[$sqlAsgn] = @(
    foreach ($u in 1..2) { foreach ($n in 1..12) { New-TestRow @{ principalId = "u$u-$runId"; resourceId = "e$n-$runId" } } }
    (New-TestRow @{ principalId = "u9-$runId"; resourceId = "e1-$runId" })   # dangling — must not be sent
)
# Source column names, NOT contract names — only the columnMap makes these land.
$script:RowsBySlot[$sqlRel] = @((New-TestRow @{ RoleID = "e1-$runId"; EntitlementID = "e2-$runId" }))

$reg = Register-SqlSystem -Cfg $cfg
$systemId = $reg.systemId
Write-Result 'System registered' ($systemId -gt 0) "id=$systemId"
Write-Result 'whoami reports the API clock' ([bool]([DateTime]::Parse($reg.serverTime))) $reg.serverTime

$state = New-SqlRunState -SystemId $systemId -ServerTime $reg.serverTime -Slots $slots -BatchSize 2 -SyncMode 'full'
$totals = @{}
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots)) {
    $totals[$slot.name] = Invoke-SqlSlot -Slot $slot -Connection $null -State $state
}
Write-Result 'Dangling assignment held back' ($totals['Grants'].dangling -eq 1) "dangling=$($totals['Grants'].dangling), sent=$($totals['Grants'].sent)"
# The mapped statement's rows carry NO contract column names; if the mapping were
# ignored every row would be skipped instead of sent.
Write-Result 'columnMap made an unaliased statement usable' ($totals['Composition'].sent -eq 1 -and $totals['Composition'].skipped -eq 0) `
    "sent=$($totals['Composition'].sent), skipped=$($totals['Composition'].skipped)"
Invoke-SqlReconcile -State $state | Out-Null
Write-Result 'Counts verified against the database' (Test-Verified -State $state) (($state.Verification | ForEach-Object { "$($_.scope)=$($_.atlas)" }) -join ', ')

# The ingest accepted everything and the cross-statement references resolved.
$principals = Invoke-Api -Path "/ingest/principals-presence" -Method Post -Body @{ tenantId = "$($cfg.server)/$($cfg.database)"; systemId = $systemId; ids = @() }
Write-Result 'Presence lookup answers for the new system' ($null -ne $principals) ''

# ── Run 2: e2 and its assignment disappear from the source ───────────────────
# A second full run must reconcile exactly those away and keep everything else.
Start-Sleep -Seconds 1
$reg2 = Register-SqlSystem -Cfg $cfg
Write-Result 'Second run resolves the SAME system' ($reg2.systemId -eq $systemId) "id=$($reg2.systemId)"
$script:RowsBySlot[$sqlRes]  = @((New-TestRow @{ id = "e1-$runId"; name = 'AD-Sales' }))
$script:RowsBySlot[$sqlAsgn] = @((New-TestRow @{ principalId = "u1-$runId"; resourceId = "e1-$runId" }))
$script:RowsBySlot[$sqlRel]  = @()

$state2 = New-SqlRunState -SystemId $systemId -ServerTime $reg2.serverTime -Slots $slots -BatchSize 2 -SyncMode 'full'
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots)) { Invoke-SqlSlot -Slot $slot -Connection $null -State $state2 | Out-Null }
$deleted = Invoke-SqlReconcile -State $state2
Write-Result 'Second run reconciled the vanished rows' ($deleted -ge 1) "deleted=$deleted"
Write-Result 'Second run verified against the database' (Test-Verified -State $state2) (($state2.Verification | ForEach-Object { "$($_.scope)=$($_.atlas)" }) -join ', ')

# ── Run 3: the id column repeats — eight rows per person, as in the field ─────
# Every row reaches the ingest and the database holds exactly the distinct ids,
# so nothing but the verification can tell that seven of every eight were lost.
Start-Sleep -Seconds 1
$reg3 = Register-SqlSystem -Cfg $cfg
$script:RowsBySlot[$sqlIdent] = @(foreach ($n in 1..8) { New-TestRow @{ id = "u1-$runId"; display_name = "Person $n" } })
$state3 = New-SqlRunState -SystemId $systemId -ServerTime $reg3.serverTime -Slots @($slots[0]) -BatchSize 2 -SyncMode 'delta'
Invoke-SqlSlot -Slot $slots[0] -Connection $null -State $state3 | Out-Null
Write-Result 'Repeated ids fail verification' (-not (Test-Verified -State $state3)) (($state3.Verification | ForEach-Object { "$($_.scope): expected $($_.expected), $($_.measured) $($_.atlas)" }) -join ', ')

# ── Run 4: the read stops early — the shape that actually shipped ────────────
# The source holds eight distinct people; one arrives. It is distinct, it lands,
# and the database agrees with it, so only the source's own count can fail this.
Start-Sleep -Seconds 1
$reg4 = Register-SqlSystem -Cfg $cfg
$script:RowsBySlot[$sqlIdent] = @((New-TestRow @{ id = "u1-$runId"; display_name = 'Person 1' }))
$script:SourceRowsBySlot[$sqlIdent] = @(foreach ($n in 1..8) { New-TestRow @{ id = "u$n-$runId"; display_name = "Person $n" } })
$state4 = New-SqlRunState -SystemId $systemId -ServerTime $reg4.serverTime -Slots @($slots[0]) -BatchSize 2 -SyncMode 'delta'
Invoke-SqlSlot -Slot $slots[0] -Connection $null -State $state4 | Out-Null
$verified4 = Test-Verified -State $state4
$readRow = @($state4.Verification | Where-Object { $_.measured -eq 'read' })[0]
Write-Result 'A read that stopped early fails verification' (-not $verified4 -and $readRow -and -not $readRow.ok) `
    (($state4.Verification | ForEach-Object { "$($_.scope): expected $($_.expected), $($_.measured) $($_.atlas)" }) -join ', ')
$script:SourceRowsBySlot.Remove($sqlIdent)

# ── Run 5: most grants name an entitlement the run did not load ──────────────
# The shape of an entitlement statement filtered on type = 'Entitlement': it loads
# a sliver, every grant for the rest dangles, and every count still agrees with
# itself. Only the unplaced bound can fail it.
Start-Sleep -Seconds 1
$reg5 = Register-SqlSystem -Cfg $cfg
$script:RowsBySlot[$sqlAsgn] = @(
    (New-TestRow @{ principalId = "u1-$runId"; resourceId = "e1-$runId" })
    foreach ($n in 1..9) { New-TestRow @{ principalId = "u1-$runId"; resourceId = "missing$n-$runId" } }
)
$state5 = New-SqlRunState -SystemId $systemId -ServerTime $reg5.serverTime -Slots @($slots[1], $slots[2]) -BatchSize 2 -SyncMode 'delta'
foreach ($slot in (Get-SqlSlotsInOrder -Slots @($slots[1], $slots[2]))) { Invoke-SqlSlot -Slot $slot -Connection $null -State $state5 | Out-Null }
$verified5 = Test-Verified -State $state5
$read5 = @($state5.Verification | Where-Object { $_.scope -eq 'read: Grants' })[0]
Write-Result 'Grants that mostly dangle fail verification' (-not $verified5 -and $read5 -and -not $read5.ok -and $read5.reason -match 'could not be placed') `
    (($state5.Verification | ForEach-Object { "$($_.scope): $($_.reason)" }) -join ' | ')

# ── Run 6: routed systems, and a grant that spans two of them ────────────────
# The customer's shape: people in the directory system, entitlements in the
# connector each one came from, every grant crossing the two. Ids are namespaced
# per RUN, so both halves of the grant resolve; namespaced per system they would
# hash in different namespaces, match nothing, and be lost without an error —
# ResourceAssignments has no foreign key on either column. The count below is
# the database's own, per system.
Start-Sleep -Seconds 1
$reg6 = Register-SqlSystem -Cfg $cfg
$sqlSys = 'SELECT systems'
$slots6 = @(
    (Resolve-SqlQuerySlot -Slot @{ name = 'Applications'; target = 'systems';     sql = $sqlSys }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Identities';   target = 'identities';  sql = $sqlIdent }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Entitlements'; target = 'resources';   sql = $sqlRes;  resourceType = 'Entitlement' }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Grants';       target = 'assignments'; sql = $sqlAsgn; resourceType = 'Entitlement' })
)
$script:RowsBySlot[$sqlSys] = @(
    (New-TestRow @{ id = "app1-$runId"; displayName = "Routed A $runId" })
    (New-TestRow @{ id = "app2-$runId"; displayName = "Routed B $runId" })
)
$script:RowsBySlot[$sqlIdent] = @((New-TestRow @{ id = "u1-$runId"; display_name = 'Ann Tester' }))
$script:RowsBySlot[$sqlRes] = @(
    (New-TestRow @{ id = "r1-$runId"; name = 'In A'; systemId = "app1-$runId" })
    (New-TestRow @{ id = "r2-$runId"; name = 'In B'; systemId = "app2-$runId" })
)
# No system column: each grant follows its resource, so these land in A and B.
$script:RowsBySlot[$sqlAsgn] = @(
    (New-TestRow @{ principalId = "u1-$runId"; resourceId = "r1-$runId" })
    (New-TestRow @{ principalId = "u1-$runId"; resourceId = "r2-$runId" })
)
$state6 = New-SqlRunState -SystemId $systemId -ServerTime $reg6.serverTime -Slots $slots6 -BatchSize 2 -SyncMode 'full' `
    -SystemType 'SQL' -Tenant $reg6.tenantId
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots6)) { Invoke-SqlSlot -Slot $slot -Connection $null -State $state6 | Out-Null }
$routed = @($state6.Systems.ByKey.Values | Sort-Object)
Write-Result 'A systems statement registered one system per row' ($routed.Count -eq 2 -and ($routed | Where-Object { $_ -eq $systemId }).Count -eq 0) `
    "ids=$($routed -join ', '), crawler own=$systemId"

# Every batch of the run shares ONE id namespace, whatever system it went to.
$namespaces = @($state6.Scopes | ForEach-Object { $_.SystemId } | Sort-Object -Unique)
Write-Result 'The run wrote to the crawler system AND both routed ones' `
    (@($namespaces | Where-Object { $_ -in $routed }).Count -eq 2 -and $namespaces -contains $systemId) "systems=$($namespaces -join ', ')"

# A full sync reconciles before it verifies, exactly as Start-SqlCrawler.ps1 does.
# Without this the run leaves the earlier scenarios' rows behind and the NEXT
# run's reconcile clears them — which reads as "a second identical run deleted
# something" when in fact the first one never finished.
Invoke-SqlReconcile -State $state6 | Out-Null

# The database's own answer, per system: the person in the crawler's system, one
# entitlement and one grant in each routed system.
foreach ($pair in @(
    @{ Key = 'principals in the crawler system'; Entity = 'principals'; SystemId = $systemId; Scope = @{ principalType = 'User' }; Expect = 1 }
    @{ Key = 'resources in A'; Entity = 'resources'; SystemId = $routed[0]; Scope = @{ resourceType = 'Entitlement' }; Expect = 1 }
    @{ Key = 'resources in B'; Entity = 'resources'; SystemId = $routed[1]; Scope = @{ resourceType = 'Entitlement' }; Expect = 1 }
    @{ Key = 'grants in A'; Entity = 'resource-assignments'; SystemId = $routed[0]; Scope = @{ assignmentType = 'Direct'; resourceType = 'Entitlement'; governed = $false }; Expect = 1 }
    @{ Key = 'grants in B'; Entity = 'resource-assignments'; SystemId = $routed[1]; Scope = @{ assignmentType = 'Direct'; resourceType = 'Entitlement'; governed = $false }; Expect = 1 }
)) {
    $r = Invoke-Api -Path '/ingest/count' -Method Post -Body @{ entity = $pair.Entity; systemId = $pair.SystemId; scope = $pair.Scope; before = $reg6.serverTime }
    Write-Result "Database holds $($pair.Expect) $($pair.Key)" ([int]$r.count -eq $pair.Expect) "count=$([int]$r.count)"
}
Write-Result 'Routed run verified end to end' (Test-Verified -State $state6) `
    (($state6.Verification | ForEach-Object { "$($_.scope)=$($_.atlas)" }) -join ', ')

# A second identical run must find the same systems and change nothing.
Start-Sleep -Seconds 1
$reg7 = Register-SqlSystem -Cfg $cfg
$state7 = New-SqlRunState -SystemId $systemId -ServerTime $reg7.serverTime -Slots $slots6 -BatchSize 2 -SyncMode 'full' `
    -SystemType 'SQL' -Tenant $reg7.tenantId
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots6)) { Invoke-SqlSlot -Slot $slot -Connection $null -State $state7 | Out-Null }
$routed2 = @($state7.Systems.ByKey.Values | Sort-Object)
Write-Result 'A second run resolves the SAME routed systems' (($routed2 -join ',') -eq ($routed -join ',')) "ids=$($routed2 -join ', ')"
$deleted7 = Invoke-SqlReconcile -State $state7
Write-Result 'A second identical run deletes nothing' ($deleted7 -eq 0) "deleted=$deleted7"

# ── Run 8: owner links, against the real ingest ──────────────────────────────
# The unit tests mock the ingest entirely, so they cannot say whether a
# ResourceOwnership resource, a HasOwnership relationship and the owner's Direct
# assignment are ACCEPTED, or whether the ownership resource's external id
# resolves across the three endpoints. Only a live run can. It also pins the two
# behaviours that matter operationally: an owner matching no account creates
# nothing and does not fail the job, and a repeat run deletes nothing.
Start-Sleep -Seconds 1
$reg8 = Register-SqlSystem -Cfg $cfg
$sqlOwn = 'SELECT owned resources'
$slots8 = @(
    (Resolve-SqlQuerySlot -Slot @{ name = 'Identities'; target = 'identities'; sql = $sqlIdent }),
    (Resolve-SqlQuerySlot -Slot @{ name = 'Owned';      target = 'resources';  sql = $sqlOwn; resourceType = 'Entitlement'; ownership = $true })
)
$script:RowsBySlot[$sqlIdent] = @(
    # The account key and the employee number are deliberately different strings,
    # so a resolver that echoed its input would fail the "by empno" row below.
    (New-TestRow @{ id = "o1-$runId"; display_name = 'Olga Owner'; employeeId = "EMP-$runId" })
)
$script:RowsBySlot[$sqlOwn] = @(
    # By account key, by employee number, and one owner who is nobody. The third
    # must cost the job nothing: 1 of 4 rows is 25%, far past the 5% bound that
    # fails a run — which it would hit if an unresolved owner counted as unplaced.
    (New-TestRow @{ id = "w1-$runId"; name = 'Owned by key';      ownerId = "o1-$runId" })
    (New-TestRow @{ id = "w2-$runId"; name = 'Owned by empno';    ownerId = "EMP-$runId" })
    (New-TestRow @{ id = "w3-$runId"; name = 'Owned by nobody';   ownerId = "ghost-$runId" })
    (New-TestRow @{ id = "w4-$runId"; name = 'Owned by no one at all' })
)
$state8 = New-SqlRunState -SystemId $systemId -ServerTime $reg8.serverTime -Slots $slots8 -BatchSize 2 -SyncMode 'full'
$totals8 = @{}
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots8)) { $totals8[$slot.name] = Invoke-SqlSlot -Slot $slot -Connection $null -State $state8 }
$own8 = $totals8['Owned'].ownership
Write-Result 'Two owners resolved, one by employee number' ($own8.ownershipsEmitted -eq 2 -and $own8.ownersKeyed -eq 1 -and $own8.ownersMapped -eq 1) `
    "emitted=$($own8.ownershipsEmitted), keyed=$($own8.ownersKeyed), mapped=$($own8.ownersMapped)"
Write-Result 'An owner matching nobody is reported, not dropped silently' ($own8.ownersUnresolved -eq 1 -and $own8.ownersUnresolvedRows -eq 1) `
    "unresolved=$($own8.ownersUnresolved) ($($own8.ownersUnresolvedSample -join ', '))"
Write-Result 'An unresolvable owner is not charged to the unplaced bound' ($totals8['Owned'].skipped -eq 0 -and $totals8['Owned'].dangling -eq 0) `
    "skipped=$($totals8['Owned'].skipped), dangling=$($totals8['Owned'].dangling)"
Invoke-SqlReconcile -State $state8 | Out-Null
Write-Result 'The ingest accepted the owner links and they verify' (Test-Verified -State $state8) `
    (($state8.Verification | ForEach-Object { "$($_.scope)=$($_.atlas)" }) -join ', ')
foreach ($pair in @(
    @{ Key = 'ownership resources'; Entity = 'resources'; Scope = @{ resourceType = 'ResourceOwnership' } }
    @{ Key = 'HasOwnership links';  Entity = 'resource-relationships'; Scope = @{ relationshipType = 'HasOwnership' } }
    @{ Key = 'owner assignments';   Entity = 'resource-assignments'; Scope = @{ assignmentType = 'Direct'; resourceType = 'ResourceOwnership'; governed = $false } }
)) {
    $r = Invoke-Api -Path '/ingest/count' -Method Post -Body @{ entity = $pair.Entity; systemId = $systemId; scope = $pair.Scope; before = $reg8.serverTime }
    Write-Result "Database holds 2 $($pair.Key)" ([int]$r.count -eq 2) "count=$([int]$r.count)"
}

# The same rows again: the ownership ids are derived from the owned resources',
# so a second run upserts and the three owner scopes reconcile nothing away.
Start-Sleep -Seconds 1
$reg9 = Register-SqlSystem -Cfg $cfg
$state9 = New-SqlRunState -SystemId $systemId -ServerTime $reg9.serverTime -Slots $slots8 -BatchSize 2 -SyncMode 'full'
foreach ($slot in (Get-SqlSlotsInOrder -Slots $slots8)) { Invoke-SqlSlot -Slot $slot -Connection $null -State $state9 | Out-Null }
$deleted9 = Invoke-SqlReconcile -State $state9
Write-Result 'A repeat run deletes and recreates no owner link' ($deleted9 -eq 0) "deleted=$deleted9"
Write-Result 'The repeat run still verifies' (Test-Verified -State $state9) `
    (($state9.Verification | ForEach-Object { "$($_.scope)=$($_.atlas)" }) -join ', ')
# ── Runs 10-17: the delta — a watermark, a key sweep, and the share ceiling ──
#
# Counted from POSTGRESQL, not from ingest totals: /ingest/count with a `before`
# older than any row is the scope's own live count. An ingest total says what was
# SENT, which is exactly the number that made a run loading an eighth of its
# source report success.
Start-Sleep -Seconds 1
$dcfg = @{ server = "sqldelta-$runId"; database = 'iiq'; configName = "SQL delta test $runId"; systemName = '' }
$dreg = Register-SqlSystem -Cfg $dcfg
$dsys = $dreg.systemId
$sqlDIdent = 'SELECT delta identities'; $sqlDRes = 'SELECT delta entitlements'
# The SQL boundary is stubbed, but the TEXT still has to be a windowed statement:
# the slot resolver refuses a watermark column on a statement that does not bind
# @Since, and the sweep key is a hash of exactly this text.
$sqlDAsgn = 'SELECT delta grants WHERE modified >= @Since'
$GRANT_SCOPE = @{ assignmentType = 'Direct'; resourceType = 'Entitlement'; governed = $false }

# The scope's own rows in the database, whenever they were written.
function Get-ScopeCount {
    param([string]$Entity, [int]$SystemId, [hashtable]$Scope)
    [int](Invoke-Api -Path '/ingest/count' -Method Post -Body @{ entity = $Entity; systemId = $SystemId; scope = $Scope; before = '1970-01-01T00:00:00.000Z' }).count
}

$dslots = @(
    (Resolve-SqlQuerySlot -Slot @{ name = "Delta identities $runId"; target = 'identities'; sql = $sqlDIdent }),
    (Resolve-SqlQuerySlot -Slot @{ name = "Delta entitlements $runId"; target = 'resources'; sql = $sqlDRes; resourceType = 'Entitlement' }),
    (Resolve-SqlQuerySlot -Slot @{ name = "Delta grants $runId"; target = 'assignments'; sql = $sqlDAsgn; resourceType = 'Entitlement'
        watermarkColumn = 'modified'; sweep = $true })
)
$dGrantSlot = $dslots[2]
$script:RowsBySlot[$sqlDIdent] = @(foreach ($u in 1..4) { New-TestRow @{ id = "du$u-$runId"; display_name = "Delta person $u" } })
$script:RowsBySlot[$sqlDRes]   = @(foreach ($n in 1..13) { New-TestRow @{ id = "de$n-$runId"; name = "Delta entitlement $n" } })
# 48 grants (4 people x 12 entitlements); de13 is spare, so a later run can add one.
$script:grantRows = [System.Collections.Generic.List[object]]::new()
$m = 1000
foreach ($u in 1..4) { foreach ($n in 1..12) { $m++; [void]$script:grantRows.Add((New-TestRow @{ principalId = "du$u-$runId"; resourceId = "de$n-$runId"; modified = $m })) } }
$script:RowsBySlot[$sqlDAsgn] = @($script:grantRows)

# One run of the delta configuration, start to finish, exactly as
# Start-SqlCrawler.ps1 orders it: slots, sweep, reconcile, verify, then — and
# only then — the marks.
function Invoke-DeltaRun {
    param([string]$SyncMode = 'delta', [double]$MaxDeleteShare = 0.05)
    $reg = Register-SqlSystem -Cfg $dcfg
    $state = New-SqlRunState -SystemId $reg.systemId -ServerTime $reg.serverTime -Slots $dslots -BatchSize 10 `
        -SyncMode $SyncMode -OverlapSeconds 0 -SweepIntervalHours 24 -SweepMaxDeleteShare $MaxDeleteShare
    foreach ($slot in (Get-SqlSlotsInOrder -Slots $dslots)) { Invoke-SqlSlot -Slot $slot -Connection 'conn' -State $state | Out-Null }
    Invoke-SqlSweep -State $state -Connection 'conn' -Slots $dslots | Out-Null
    Invoke-SqlReconcile -State $state | Out-Null
    $state.Verified = Test-Verified -State $state
    if ($state.Verified) { Save-SqlWatermarks -State $state | Out-Null; Save-SqlSweepMarks -State $state | Out-Null }
    return $state
}
function Get-GrantRowsRead { param([hashtable]$State) [long]$State.Totals["Delta grants $runId"].rows }

# 1. The first run has no mark, so it reads everything.
$dA = Invoke-DeltaRun -SyncMode 'full'
$countA = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'First run reads every grant and lands them all' ((Get-GrantRowsRead $dA) -eq 48 -and $countA -eq 48) "read=$(Get-GrantRowsRead $dA), postgres=$countA"
Write-Result 'First run verified, so its watermark was stored' ($dA.Verified -and (Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dGrantSlot)) -eq '1048') `
    "token=$(Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dGrantSlot))"

# 2. A delta against UNCHANGED data: only the boundary row is re-read (the mark
#    is inclusive), and the database is untouched.
$dB = Invoke-DeltaRun
$countB = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'A delta after no change reads a window, not the table' ((Get-GrantRowsRead $dB) -eq 1) "read=$(Get-GrantRowsRead $dB) of 48"
Write-Result 'A delta after no change writes nothing and deletes nothing' ($countB -eq 48) "postgres=$countB (was $countA)"

# 3. A delta picks up an update and an insertion.
$script:grantRows[0]['modified'] = 2000                                   # du1/de1 updated at the source
[void]$script:grantRows.Add((New-TestRow @{ principalId = "du1-$runId"; resourceId = "de13-$runId"; modified = 2001 }))
$script:RowsBySlot[$sqlDAsgn] = @($script:grantRows)
$dC = Invoke-DeltaRun
$countC = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'A delta picks up the update and the insertion, and only those' ((Get-GrantRowsRead $dC) -eq 3 -and $countC -eq 49) `
    "read=$(Get-GrantRowsRead $dC) (boundary + update + insert), postgres=$countC"

# 4. A sweep removes exactly what disappeared. Two grants vanish from the source —
#    neither of them the boundary row, so the delta half still verifies.
$script:grantRows.RemoveAt(5)     # du1/de6
$script:grantRows.RemoveAt(5)     # du1/de7
$script:RowsBySlot[$sqlDAsgn] = @($script:grantRows)
Remove-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlSweepKey -Slot $dGrantSlot)   # make the sweep due
$dD = Invoke-DeltaRun
$countD = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
$sweptD = @($dD.Sweeps)[0]
Write-Result 'A sweep removes exactly what disappeared, and nothing else' ($countD -eq 47 -and $sweptD.Deleted -eq 2) `
    "postgres=$countD (was $countC), deleted=$($sweptD.Deleted), staged=$($sweptD.Staged)"

# 5. A second delta immediately after is a no-op: the sweep is not due again and
#    the window has not moved.
$dE = Invoke-DeltaRun
$countE = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'A second delta immediately after is a no-op' ($countE -eq 47 -and @($dE.Sweeps).Count -eq 0) `
    "postgres=$countE, sweeps=$(@($dE.Sweeps).Count)"

# 6. The share ceiling. Ten more grants vanish — 10 of 47 is 21%, far past the
#    5% a half-aggregated source is indistinguishable from. The finalize must
#    refuse and write NOTHING.
for ($i = 0; $i -lt 10; $i++) { $script:grantRows.RemoveAt(10) }
$script:RowsBySlot[$sqlDAsgn] = @($script:grantRows)
Remove-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlSweepKey -Slot $dGrantSlot)
$refused = $false; $refusal = ''
try { Invoke-DeltaRun | Out-Null } catch { $refused = $true; $refusal = $_.Exception.Message }
$countF = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'A sweep past the share ceiling is refused' $refused ($refusal -replace '\s+', ' ')
Write-Result 'And it removed nothing at all' ($countF -eq 47) "postgres=$countF (was $countE)"
Write-Result 'A refused run leaves the watermark where it was' `
    ((Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dGrantSlot)) -eq '2001') `
    "token=$(Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dGrantSlot))"

# 7. The same sweep with the override goes through.
Remove-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlSweepKey -Slot $dGrantSlot)
Invoke-DeltaRun -MaxDeleteShare 1 | Out-Null
$countG = Get-ScopeCount -Entity 'resource-assignments' -SystemId $dsys -Scope $GRANT_SCOPE
Write-Result 'With the override, the same removal is applied' ($countG -eq 37) "postgres=$countG (was $countF)"

# 8. Editing the statement resets its watermark: the next run must read
#    everything, not skip the rows the new shape would have returned.
$dslots[2] = Resolve-SqlQuerySlot -Slot @{ name = "Delta grants $runId"; target = 'assignments'; sql = "$sqlDAsgn -- narrowed"
    resourceType = 'Entitlement'; watermarkColumn = 'modified'; sweep = $true }
$script:RowsBySlot["$sqlDAsgn -- narrowed"] = @($script:grantRows)
$dH = Invoke-DeltaRun
Write-Result 'An edited statement starts from zero instead of skipping rows' ((Get-GrantRowsRead $dH) -eq 37) `
    "read=$(Get-GrantRowsRead $dH) of 37"

# 9. A source that is aggregated WHILE it is read. The statement holds 37 rows
#    when the read starts and 40 when it ends; the read delivers the 37 it saw.
#    Held to the single count taken afterwards — as it was — this run fails and
#    then, because the verification runs before Save-SqlWatermarks, stores no
#    watermark for ANY statement, so the delta import can never establish a
#    baseline. It must verify, and the mark must move.
$narrowed = "$sqlDAsgn -- narrowed"
$script:SourceRowsBeforeBySlot[$narrowed] = @($script:grantRows)
$script:SourceRowsBySlot[$narrowed] = @(@($script:grantRows) + @(
    foreach ($n in 1..3) { New-TestRow @{ principalId = "du2-$runId"; resourceId = "de$n-$runId"; modified = (3000 + $n) } }))
Remove-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dslots[2])
$dI = Invoke-DeltaRun -SyncMode 'full'
$readRowI = @($dI.Verification | Where-Object { $_.scope -eq "read: Delta grants $runId" })[0]
Write-Result 'A source that grew during the read still verifies' ($dI.Verified -and $readRowI -and $readRowI.ok) `
    "read=$(Get-GrantRowsRead $dI), source after=$(@($script:SourceRowsBySlot[$narrowed]).Count), reason=$($readRowI.reason)"
Write-Result 'And the drift is reported rather than swallowed' ($readRowI -and $readRowI.reason -match 'moved by 3') "reason=$($readRowI.reason)"
Write-Result 'So the watermark advances instead of being withheld' `
    ((Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dslots[2])) -eq '2001') `
    "token=$(Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dslots[2]))"

# 10. The same moving source, but the read stopped early: 37 delivered of a
#     statement that held 370 at both ends. Drift cannot explain that, and the
#     run must fail with the mark left where run 9 put it.
$script:SourceRowsBeforeBySlot[$narrowed] = @(@($script:grantRows) * 10)
$script:SourceRowsBySlot[$narrowed] = @(@($script:grantRows) * 10)
$dJ = Invoke-DeltaRun -SyncMode 'full'
$readRowJ = @($dJ.Verification | Where-Object { $_.scope -eq "read: Delta grants $runId" })[0]
Write-Result 'A truncated read still fails, whatever the source is doing' ((-not $dJ.Verified) -and $readRowJ -and -not $readRowJ.ok) `
    "verified=$($dJ.Verified), reason=$($readRowJ.reason)"
Write-Result 'And an unverified run leaves the watermark alone' `
    ((Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dslots[2])) -eq '2001') `
    "token=$(Get-CrawlerDeltaToken -SystemId $dsys -Endpoint (Get-SqlWatermarkKey -Slot $dslots[2]))"
$script:SourceRowsBeforeBySlot.Remove($narrowed)
$script:SourceRowsBySlot.Remove($narrowed)

# ── Reconcile safety: the endpoint refuses what it must ──────────────────────
foreach ($case in @(
    @{ Name = 'unsystemed entity'; Body = @{ entity = 'identities'; systemId = $systemId; before = $reg.serverTime } },
    @{ Name = 'future before';     Body = @{ entity = 'resources';  systemId = $systemId; before = ([DateTime]::UtcNow.AddHours(1).ToString('o')) } },
    @{ Name = 'unknown entity';    Body = @{ entity = 'nonsense';   systemId = $systemId; before = $reg.serverTime } }
)) {
    $status = 0
    try { Invoke-Api -Path '/ingest/reconcile' -Method Post -Body $case.Body | Out-Null }
    catch { $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
    Write-Result "Reconcile refuses a $($case.Name)" ($status -eq 400) "status=$status"
}

# ── Cleanup ──────────────────────────────────────────────────────────────────
# $routed is empty when the run never reached the routed scenario (an earlier
# check threw), so this still deletes the one system the run definitely made.
foreach ($id in (@($systemId) + @($routed) + @($dsys))) {
    try { Invoke-Api -Path "/admin/systems/$id" -Method Delete | Out-Null; Write-Host "  Cleaned up system $id" -ForegroundColor DarkGray }
    catch { Write-Host "  (could not delete test system ${id}: $($_.Exception.Message))" -ForegroundColor Yellow }
}

if ($script:failures -gt 0) {
    Write-Error "SQL crawler integration test: $script:failures check(s) failed"
    exit 1
}
Write-Host "`nAll SQL crawler integration checks passed" -ForegroundColor Green
