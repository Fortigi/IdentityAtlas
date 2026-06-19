<#
.SYNOPSIS
    Idempotent test-data seeder for the midPoint crawler — deterministic fixtures
    with fixed OIDs covering every object type, relationship, and sync phase.

.DESCRIPTION
    This is a function library (no side effects on dot-source, so the dispatcher can
    safely load it alongside the crawler). It exposes:

      Get-MidpointFixtureSpec  — the single source of truth: fixed OIDs + expected
                                 Identity Atlas reconciliation counts.
      New-MidpointTestData      — create/overwrite all fixtures in midPoint (idempotent,
                                  PUT /{type}/{oid}?options=overwrite with oid in body).
      Remove-MidpointTestData   — delete all fixtures (and any provisioned shadows).

    Fixtures (every name is prefixed "IA-Test-" so they are obvious in any UI):
      Orgs   : Root → ChildA, ChildB (hierarchy via OrgType assignment → parentOrgRef)
      Roles  : Role-A (induces Role-B), Role-B
      Service: Service-1
      Resource: CSV connector resource (provisions accounts to a local CSV file → shadows)
      Users  : Alice (Role-A, ChildA, CSV account), Bob (Service-1, ChildB, CSV account),
               Carol (Role-B, Root, no account)

    PREREQUISITE for shadow provisioning: the CSV file (CsvFilePath) must exist on the
    midPoint server with the header "login,firstName,lastName,email". Create it once with, e.g.:
      docker exec <midpoint-container> sh -lc 'printf "login,firstName,lastName,email\n" > <CsvFilePath>'

    DEPLOYMENT NOTE — midPoint server paths are environment-specific. The default
    CsvFilePath (/opt/midpoint/var/ia-test-accounts.csv) matches the Evolveum DOCKER
    DEMO image (MP_DIR=/opt/midpoint); a production / native midPoint install uses a
    different home (e.g. ~/.midpoint or a configured midpoint.home). ALWAYS pass
    -CsvFilePath for non-demo environments — never assume the demo path. The crawler
    itself is path-agnostic (REST only); only this test-data seeder touches a server path.

.EXAMPLE
    . ./Seed-MidpointTestData.ps1
    New-MidpointTestData -BaseUrl http://midpoint-dev:8080/midpoint -Username administrator -Password $pw
#>

#region Fixture specification

function Get-MidpointFixtureSpec {
    [CmdletBinding()]
    param()
    $csvConnectorOid = '0c3e457f-c7a1-44b4-a481-d14fd188bf91'  # com.evolveum.polygon.connector.csv.CsvConnector on midpoint-dev
    return [pscustomobject]@{
        csvConnectorOid = $csvConnectorOid
        orgs = @(
            @{ oid = '1a000000-0000-4000-8000-000000000020'; name = 'IA-Test-Org-Root';   displayName = 'IA Test Org Root';    parent = $null }
            @{ oid = '1a000000-0000-4000-8000-000000000021'; name = 'IA-Test-Org-ChildA'; displayName = 'IA Test Org Child A'; parent = '1a000000-0000-4000-8000-000000000020' }
            @{ oid = '1a000000-0000-4000-8000-000000000022'; name = 'IA-Test-Org-ChildB'; displayName = 'IA Test Org Child B'; parent = '1a000000-0000-4000-8000-000000000020' }
        )
        roles = @(
            @{ oid = '1a000000-0000-4000-8000-000000000010'; name = 'IA-Test-Role-A'; displayName = 'IA Test Role A'; induces = '1a000000-0000-4000-8000-000000000011' }
            @{ oid = '1a000000-0000-4000-8000-000000000011'; name = 'IA-Test-Role-B'; displayName = 'IA Test Role B'; induces = $null }
        )
        services = @(
            @{ oid = '1a000000-0000-4000-8000-000000000030'; name = 'IA-Test-Service-1'; displayName = 'IA Test Service 1' }
        )
        resource = @{ oid = '1a000000-0000-4000-8000-000000000040'; name = 'IA-Test-CSV-Resource' }
        # Access certification campaign with 3 decided cases (proves Reviews → CertificationDecisions)
        campaign = @{
            oid = '1a000000-0000-4000-8000-000000000050'; name = 'IA-Test-Review-Campaign'
            reviewerOid = '00000000-0000-0000-0000-000000000002'   # administrator (well-known midPoint oid)
            cases = @(
                @{ id = 1; user = '1a000000-0000-4000-8000-000000000001'; target = '1a000000-0000-4000-8000-000000000010'; targetType = 'RoleType';    outcome = 'accept'; comment = 'Role A confirmed for Alice' }
                @{ id = 2; user = '1a000000-0000-4000-8000-000000000003'; target = '1a000000-0000-4000-8000-000000000011'; targetType = 'RoleType';    outcome = 'revoke'; comment = 'Role B revoked for Carol' }
                @{ id = 3; user = '1a000000-0000-4000-8000-000000000002'; target = '1a000000-0000-4000-8000-000000000030'; targetType = 'ServiceType'; outcome = 'accept'; comment = 'Service 1 confirmed for Bob' }
            )
        }
        users = @(
            @{ oid = '1a000000-0000-4000-8000-000000000001'; name = 'IA-Test-Alice'; fullName = 'IA Test Alice'; given = 'Alice'; family = 'Tester'; email = 'alice@ia-test.local'
               roleOid = '1a000000-0000-4000-8000-000000000010'; roleType = 'RoleType'
               orgOid  = '1a000000-0000-4000-8000-000000000021'; account = $true }
            @{ oid = '1a000000-0000-4000-8000-000000000002'; name = 'IA-Test-Bob'; fullName = 'IA Test Bob'; given = 'Bob'; family = 'Tester'; email = 'bob@ia-test.local'
               roleOid = '1a000000-0000-4000-8000-000000000030'; roleType = 'ServiceType'
               orgOid  = '1a000000-0000-4000-8000-000000000022'; account = $true }
            @{ oid = '1a000000-0000-4000-8000-000000000003'; name = 'IA-Test-Carol'; fullName = 'IA Test Carol'; given = 'Carol'; family = 'Tester'; email = 'carol@ia-test.local'
               roleOid = '1a000000-0000-4000-8000-000000000011'; roleType = 'RoleType'
               orgOid  = '1a000000-0000-4000-8000-000000000020'; account = $false }
        )
        # Expected Identity Atlas state after a crawl (for the reconciliation report)
        expected = @{
            contexts            = 3   # 3 orgs as OrgUnit contexts
            resourcesBusinessRole = 2 # Role-A, Role-B
            resourcesService    = 1   # Service-1
            identities          = 3   # Alice, Bob, Carol
            focusPrincipals     = 3   # midPoint user accounts
            shadowPrincipals    = 2   # Alice + Bob CSV accounts
            governedAssignments = 4   # direct: Alice→Role-A, Bob→Service-1, Carol→Role-B; inherited: Alice→Role-B (Role-A induces Role-B, via roleMembershipRef)
            containsRelations   = 1   # Role-A → Role-B
            contextMembers      = 3   # Alice∈ChildA, Bob∈ChildB, Carol∈Root
            certificationDecisions = 3 # Alice/Role-A accept, Carol/Role-B revoke, Bob/Service-1 accept
        }
    }
}

#endregion Fixture specification

#region REST helpers (internal)

function Get-SeedHeaders {
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param([string]$Username, [string]$Password)
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}"))
    return @{ Authorization = "Basic $enc"; 'Content-Type' = 'application/json'; Accept = 'application/json' }
}

function Get-SeedRestRoot {
    [CmdletBinding()] param([string]$BaseUrl)
    $b = $BaseUrl.Trim().TrimEnd('/')
    if ($b -match '(?i)/ws/rest$') { return $b }
    if ($b -match '(?i)/midpoint$') { return "$b/ws/rest" }
    return "$b/midpoint/ws/rest"
}

function Invoke-SeedPut {
    [CmdletBinding()]
    param([string]$RestRoot, [hashtable]$Headers, [string]$Type, [string]$Oid, [hashtable]$Object)
    $body = @{ $Type = $Object } | ConvertTo-Json -Depth 30 -Compress
    $uri  = "$RestRoot/${Type}s/$Oid`?options=overwrite"
    Invoke-RestMethod -Uri $uri -Method Put -Headers $Headers -Body $body -TimeoutSec 60 | Out-Null
}

#endregion REST helpers

#region Seeding

function New-MidpointTestData {
    <#
    .SYNOPSIS  Create/overwrite all midPoint fixtures. Idempotent.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [string]$Username,
        [Parameter(Mandatory)] [string]$Password,
        [string]$CsvFilePath = '/opt/midpoint/var/ia-test-accounts.csv'
    )
    $spec    = Get-MidpointFixtureSpec
    $root    = Get-SeedRestRoot -BaseUrl $BaseUrl
    $headers = Get-SeedHeaders -Username $Username -Password $Password

    Write-Host "Seeding midPoint fixtures → $root" -ForegroundColor Cyan

    # ── Orgs ──────────────────────────────────────────────────────────────────
    foreach ($o in $spec.orgs) {
        $obj = @{ oid = $o.oid; name = $o.name; displayName = $o.displayName }
        # Org hierarchy in midPoint is established via an assignment to the parent org
        # (midPoint then computes parentOrgRef); a raw parentOrgRef is ignored on add.
        if ($o.parent) { $obj['assignment'] = @( @{ targetRef = @{ oid = $o.parent; type = 'OrgType' } } ) }
        Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'org' -Oid $o.oid -Object $obj
        Write-Host "  org   $($o.name)$(if ($o.parent) { ' (child)' })" -ForegroundColor DarkGray
    }

    # ── Roles (Role-A induces Role-B) ──────────────────────────────────────────
    foreach ($r in $spec.roles) {
        $obj = @{ oid = $r.oid; name = $r.name; displayName = $r.displayName }
        if ($r.induces) { $obj['inducement'] = @( @{ targetRef = @{ oid = $r.induces; type = 'RoleType' } } ) }
        Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'role' -Oid $r.oid -Object $obj
        Write-Host "  role  $($r.name)" -ForegroundColor DarkGray
    }

    # ── Services ───────────────────────────────────────────────────────────────
    foreach ($s in $spec.services) {
        $obj = @{ oid = $s.oid; name = $s.name; displayName = $s.displayName }
        Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'service' -Oid $s.oid -Object $obj
        Write-Host "  svc   $($s.name)" -ForegroundColor DarkGray
    }

    # ── CSV resource (for shadow provisioning) ─────────────────────────────────
    $ccns = 'http://midpoint.evolveum.com/xml/ns/public/connector/icf-1/connector-schema-3'
    $cpns = 'http://midpoint.evolveum.com/xml/ns/public/connector/icf-1/bundle/com.evolveum.polygon.connector-csv/com.evolveum.polygon.connector.csv.CsvConnector'
    $resObj = @{
        oid          = $spec.resource.oid
        name         = $spec.resource.name
        connectorRef = @{ oid = $spec.csvConnectorOid; type = 'ConnectorType' }
        # [ordered] so '@ns' serialises BEFORE sibling fields — midPoint rejects a
        # namespace declared after other fields ("Namespace declared after other fields").
        connectorConfiguration = [ordered]@{
            '@ns' = $ccns
            configurationProperties = [ordered]@{
                '@ns' = $cpns
                filePath = $CsvFilePath; encoding = 'utf-8'; fieldDelimiter = ','; uniqueAttribute = 'login'
            }
        }
        schemaHandling = @{
            objectType = @( @{
                kind = 'account'; intent = 'default'; default = $true
                objectClass = 'ri:AccountObjectClass'
                attribute = @(
                    @{ ref = 'ri:login';     outbound = @{ strength = 'strong'; source = @{ path = '$user/name' } } }
                    @{ ref = 'ri:firstName'; outbound = @{ source = @{ path = '$user/givenName' } } }
                    @{ ref = 'ri:lastName';  outbound = @{ source = @{ path = '$user/familyName' } } }
                    @{ ref = 'ri:email';     outbound = @{ source = @{ path = '$user/emailAddress' } } }
                )
            } )
        }
    }
    Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'resource' -Oid $spec.resource.oid -Object $resObj
    Write-Host "  res   $($spec.resource.name)" -ForegroundColor DarkGray
    try {
        Invoke-RestMethod -Uri "$root/resources/$($spec.resource.oid)/test" -Method Post -Headers $headers -TimeoutSec 60 | Out-Null
        Write-Host "  res   connection test ok" -ForegroundColor DarkGray
    } catch {
        Write-Host "  res   connection test failed: $($_.Exception.Message) (CSV file may be missing at $CsvFilePath)" -ForegroundColor Yellow
    }

    # ── Users (assignments: role/service + org; optional CSV construction) ──────
    foreach ($u in $spec.users) {
        $assignments = @(
            @{ targetRef = @{ oid = $u.roleOid; type = $u.roleType } }   # role or service membership
            @{ targetRef = @{ oid = $u.orgOid;  type = 'OrgType' } }     # org membership → parentOrgRef
        )
        if ($u.account) {
            $assignments += @{ construction = @{ resourceRef = @{ oid = $spec.resource.oid; type = 'ResourceType' } } }
        }
        $obj = @{
            oid = $u.oid; name = $u.name; fullName = $u.fullName
            givenName = $u.given; familyName = $u.family; emailAddress = $u.email
            assignment = $assignments
        }
        Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'user' -Oid $u.oid -Object $obj
        Write-Host "  user  $($u.name)$(if ($u.account) { ' (+CSV account)' })" -ForegroundColor DarkGray
    }

    # ── Certification campaign (decided cases) ─────────────────────────────────
    $cmp = $spec.campaign
    $cases = @($cmp.cases | ForEach-Object {
        @{
            id = $_.id
            objectRef = @{ oid = $_.user;   type = 'UserType' }
            targetRef = @{ oid = $_.target; type = $_.targetType }
            stageNumber = 1; iteration = 1; outcome = $_.outcome
            workItem = @( @{ id = 1; stageNumber = 1; iteration = 1
                             assigneeRef = @{ oid = $cmp.reviewerOid; type = 'UserType' }
                             output = @{ outcome = $_.outcome; comment = $_.comment } } )
        }
    })
    $campObj = @{ oid = $cmp.oid; name = $cmp.name; state = 'closed'; stageNumber = 1; iteration = 1; case = $cases }
    Invoke-SeedPut -RestRoot $root -Headers $headers -Type 'accessCertificationCampaign' -Oid $cmp.oid -Object $campObj
    Write-Host "  campaign $($cmp.name) ($($cases.Count) decided cases)" -ForegroundColor DarkGray

    Write-Host "Seeding complete." -ForegroundColor Green
    return $spec
}

function Remove-MidpointTestData {
    <#
    .SYNOPSIS  Delete all midPoint fixtures (users first so accounts deprovision), then shadows.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$BaseUrl,
        [Parameter(Mandatory)] [string]$Username,
        [Parameter(Mandatory)] [string]$Password
    )
    $spec    = Get-MidpointFixtureSpec
    $root    = Get-SeedRestRoot -BaseUrl $BaseUrl
    $headers = Get-SeedHeaders -Username $Username -Password $Password

    function Remove-One { param([string]$Type, [string]$Oid)
        try { Invoke-RestMethod -Uri "$root/$Type/$Oid" -Method Delete -Headers $headers -TimeoutSec 60 | Out-Null; Write-Host "  - $Type/$Oid" -ForegroundColor DarkGray }
        catch {
            $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
            if ($code -ne 404) { Write-Host "  ! $Type/$Oid -> $($_.Exception.Message)" -ForegroundColor Yellow }
        }
    }

    Write-Host "Removing midPoint fixtures → $root" -ForegroundColor Cyan
    Remove-One -Type 'accessCertificationCampaigns' -Oid $spec.campaign.oid
    foreach ($u in $spec.users)    { Remove-One -Type 'users'    -Oid $u.oid }
    # Delete shadows still attached to the CSV resource (deprovisioning may have left them)
    try {
        $resp = Invoke-RestMethod -Uri "$root/shadows/search?options=raw" -Method Post -Headers $headers `
            -Body (@{ query = @{ paging = @{ maxSize = 1000 } } } | ConvertTo-Json -Depth 10) -TimeoutSec 120
        $list = $resp.object.object; if ($list -and $list -isnot [array]) { $list = @($list) }
        foreach ($s in @($list)) {
            if ((Get-MidpointRefOidLocal $s.resourceRef) -eq $spec.resource.oid) { Remove-One -Type 'shadows' -Oid ([string]$s.oid) }
        }
    } catch { Write-Host "  (shadow cleanup skipped: $($_.Exception.Message))" -ForegroundColor Yellow }
    foreach ($s in $spec.services) { Remove-One -Type 'services' -Oid $s.oid }
    foreach ($r in $spec.roles)    { Remove-One -Type 'roles'    -Oid $r.oid }
    Remove-One -Type 'resources' -Oid $spec.resource.oid
    foreach ($o in $spec.orgs)     { Remove-One -Type 'orgs'     -Oid $o.oid }
    Write-Host "Removal complete." -ForegroundColor Green
}

# Local ref-oid helper so this library does not depend on Invoke-MidpointApi.ps1 load order.
function Get-MidpointRefOidLocal {
    [CmdletBinding()] param($Ref)
    if ($null -eq $Ref) { return '' }
    if ($Ref -is [array]) { if ($Ref.Count -eq 0) { return '' } $Ref = $Ref[0] }
    if ($Ref.oid) { return [string]$Ref.oid }
    return ''
}

#endregion Seeding
