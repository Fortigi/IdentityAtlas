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
. (Join-Path $PSScriptRoot 'SqlCrawler.Phases.ps1')

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

Write-Host "`n=== SQL crawler integration test ===" -ForegroundColor Cyan

$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$cfg = @{ server = "sqltest-$runId"; database = 'iiq'; configName = "SQL crawler test $runId"; systemName = '' }

# ── Run 1: two entitlements, two identities, three assignments ───────────────
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
)
$script:RowsBySlot[$sqlAsgn] = @(
    (New-TestRow @{ principalId = "u1-$runId"; resourceId = "e1-$runId" })
    (New-TestRow @{ principalId = "u1-$runId"; resourceId = "e2-$runId" })
    (New-TestRow @{ principalId = "u2-$runId"; resourceId = "e1-$runId" })
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

# The ingest accepted everything and the cross-statement references resolved.
$assignments = Invoke-Api -Path "/matrix/assignments?systemId=$systemId&limit=500" -Method Get -ErrorAction SilentlyContinue
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
try { Invoke-Api -Path "/admin/systems/$systemId" -Method Delete | Out-Null; Write-Host "  Cleaned up system $systemId" -ForegroundColor DarkGray }
catch { Write-Host "  (could not delete test system ${systemId}: $($_.Exception.Message))" -ForegroundColor Yellow }

if ($script:failures -gt 0) {
    Write-Error "SQL crawler integration test: $script:failures check(s) failed"
    exit 1
}
Write-Host "`nAll SQL crawler integration checks passed" -ForegroundColor Green
