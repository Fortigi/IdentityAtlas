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

. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngestStream.ps1')
. (Join-Path $PSScriptRoot '..' 'shared' 'Get-CrawlerSystemName.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Functions.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Transform.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Systems.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Contexts.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Phases.ps1')
. (Join-Path $PSScriptRoot 'SqlCrawler.Verify.ps1')

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
function Invoke-SqlQueryStream {
    [CmdletBinding()]
    param($Connection, [string]$Sql, [scriptblock]$OnRow, [int]$CommandTimeout = 600, [bool]$Paged = $false, [int]$PageSize = 10000)
    $rows = @($script:RowsBySlot[$Sql])
    foreach ($r in $rows) { & $OnRow $r }
    return [long]$rows.Count
}

# The source-side counts, answered from what the SOURCE holds: the replayed rows,
# unless a scenario says the source holds more than the reader delivers.
$script:SourceRowsBySlot = @{}
function Measure-SqlSource {
    [CmdletBinding()]
    param($Connection, [hashtable]$Slot, [hashtable]$Map, [int]$CommandTimeout = 600)
    # @() around the whole if: an if-expression unrolls a one-row array into the row itself.
    $rows = @(if ($script:SourceRowsBySlot.ContainsKey($Slot.sql)) { $script:SourceRowsBySlot[$Slot.sql] } else { $script:RowsBySlot[$Slot.sql] })
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
foreach ($id in (@($systemId) + @($routed))) {
    try { Invoke-Api -Path "/admin/systems/$id" -Method Delete | Out-Null; Write-Host "  Cleaned up system $id" -ForegroundColor DarkGray }
    catch { Write-Host "  (could not delete test system ${id}: $($_.Exception.Message))" -ForegroundColor Yellow }
}

if ($script:failures -gt 0) {
    Write-Error "SQL crawler integration test: $script:failures check(s) failed"
    exit 1
}
Write-Host "`nAll SQL crawler integration checks passed" -ForegroundColor Green
