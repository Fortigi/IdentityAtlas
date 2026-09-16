<#
.SYNOPSIS
    Transform Omada Identity CSV exports to the Identity Atlas canonical schema.

.DESCRIPTION
    Reads the Omada-format CSVs (semicolon-delimited, with Omada-specific column
    names like _ID, _DISPLAYNAME, ROLETYPEREF_VALUE, etc.) and writes Identity
    Atlas schema CSVs (ExternalId, DisplayName, ResourceType, etc.) to an output
    folder. The output can then be uploaded directly to the CSV crawler wizard.

    This is the ONLY place where Omada-specific column knowledge lives. The
    Identity Atlas crawler itself reads exactly the canonical column names.

    Supported input files:
      System.csv / Systems.csv       → Systems.csv
      Orgunits.csv                   ┐
      Jobtitle.csv                   ├→ Contexts.csv  (OrgUnit / JobTitle / Position)
      Employment.csv                 ┘
      Employment.csv                 → ContextMembers.csv
      Permission-full-details.csv
        / Permissions.csv            → Resources.csv
      Permission-Nesting.csv         → ResourceRelationships.csv
      Users.csv                      → Users.csv
      Account-Permission.csv         → Assignments.csv
      Identities.csv                 → Identities.csv
      Identities.csv + Users.csv     → IdentityMembers.csv
      CRAs.csv                       → Certifications.csv

.PARAMETER SourceFolder
    Folder containing the original Omada CSV exports.

.PARAMETER OutputFolder
    Folder to write the transformed Identity Atlas CSVs. Created if missing.

.PARAMETER Delimiter
    CSV delimiter (default: ";")

.EXAMPLE
    .\omada-to-identityatlas.ps1 -SourceFolder .\OmadaExport -OutputFolder .\ForImport
#>

[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$SourceFolder,
    [Parameter(Mandatory)] [string]$OutputFolder,
    [string]$Delimiter = ';'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null }

function Read-Src { param([string]$Name)
    $p = Join-Path $SourceFolder $Name
    if (-not (Test-Path $p)) { Write-Host "  $Name not found - skipping" -ForegroundColor Yellow; return $null }
    $rows = Import-Csv -Path $p -Delimiter $Delimiter -Encoding UTF8
    Write-Host "  $Name`: $($rows.Count) rows" -ForegroundColor Gray
    return $rows
}

function Write-Out { param([string]$Name, [array]$Data)
    if (-not $Data -or $Data.Count -eq 0) { Write-Host "  $Name`: 0 rows (skipped)" -ForegroundColor Yellow; return }
    $p = Join-Path $OutputFolder $Name
    $Data | Export-Csv -Path $p -Delimiter $Delimiter -NoTypeInformation -Encoding UTF8
    Write-Host "  $Name`: $($Data.Count) rows" -ForegroundColor Green
}

# ─── Systems ─────────────────────────────────────────────────────
function Convert-OmadaSystems {
    Write-Host "Systems:" -ForegroundColor Cyan
    $sys = Read-Src 'System.csv'
    if (-not $sys) { $sys = Read-Src 'Systems.csv' }
    if (-not $sys) { return }
    Write-Out 'Systems.csv' @($sys | ForEach-Object {
        [PSCustomObject]@{
            ExternalId  = $_._ID
            DisplayName = $_._DISPLAYNAME
            Description = $_.DESCRIPTION
        }
    })
}

# ─── Contexts ────────────────────────────────────────────────────
# Collects OrgUnit (Orgunits.csv), JobTitle (Jobtitle.csv), and Position
# (derived from Employment.csv as unique OrgUnit+JobTitle combinations) into a
# single Contexts.csv. All three sections are optional — any missing source file
# just contributes zero rows.
function Add-OmadaOrgUnitContexts {
    param([System.Collections.Generic.List[object]]$Contexts)
    $ou = Read-Src 'Orgunits.csv'
    if (-not $ou) { return }
    foreach ($r in $ou) {
        $Contexts.Add([PSCustomObject]@{
            ExternalId       = $r.OU_KEY
            DisplayName      = $r.OU_Name
            ContextType      = 'OrgUnit'
            Description      = $r.OU_Description
            ParentExternalId = $r.Parent_OU_Key
        })
    }
}

function Add-OmadaJobTitleContexts {
    param([System.Collections.Generic.List[object]]$Contexts)
    $jt = Read-Src 'Jobtitle.csv'
    if (-not $jt) { return }
    foreach ($r in $jt) {
        $Contexts.Add([PSCustomObject]@{
            ExternalId       = $r.JOBTITLE_ID
            DisplayName      = $r.JobTitleName
            ContextType      = 'JobTitle'
            Description      = $r.DESCRIPTION
            ParentExternalId = ''
        })
    }
}

# Position contexts are the unique OrgUnit|JobTitle combinations seen in
# Employment.csv (which is read once by the orchestrator and reused for members).
function Add-OmadaPositionContexts {
    param([System.Collections.Generic.List[object]]$Contexts, $Employment)
    if (-not $Employment) { return }
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($e in $Employment) {
        if (-not $e.OUREF_ID -or -not $e.JOBTITLE_REF_ID) { continue }
        $posId = "$($e.OUREF_ID)|$($e.JOBTITLE_REF_ID)"
        if ($seen.Add($posId)) {
            $Contexts.Add([PSCustomObject]@{
                ExternalId       = $posId
                DisplayName      = "$($e.OUREF_VALUE) — $($e.JOBTITLE_REF_VALUE)"
                ContextType      = 'Position'
                Description      = ''
                ParentExternalId = $e.OUREF_ID
            })
        }
    }
}

function Convert-OmadaContexts {
    Write-Host "Contexts:" -ForegroundColor Cyan
    $script:allContexts = [System.Collections.Generic.List[object]]::new()
    Add-OmadaOrgUnitContexts  -Contexts $script:allContexts
    Add-OmadaJobTitleContexts -Contexts $script:allContexts
    # Employment.csv drives both Position contexts and ContextMembers.
    # Read once here so we can iterate twice without re-parsing.
    $script:emp = Read-Src 'Employment.csv'
    Add-OmadaPositionContexts -Contexts $script:allContexts -Employment $script:emp
    Write-Out 'Contexts.csv' $script:allContexts.ToArray()
}

# ─── Context Members (from Employment.csv) ────────────────────────
# Each employment row produces up to three memberships per identity:
#   Identity → OrgUnit   (via OUREF_ID)
#   Identity → JobTitle  (via JOBTITLE_REF_ID)
#   Identity → Position  (via the derived OrgUnit|JobTitle key)
# All employments are included regardless of ValidFrom/ValidTo.
#
# Guard: only emit a membership row when the referenced ContextExternalId is
# actually present in Contexts.csv. Employment records can reference org units
# or job titles that were archived or excluded from the Omada export; sending
# those would cause a FK violation (ContextMembers_contextId_fkey) in the API.
function Add-OmadaContextMember {
    param(
        [System.Collections.Generic.List[object]]$Members,
        [string]$ContextId,
        [string]$IdentityId,
        [System.Collections.Generic.HashSet[string]]$Known
    )
    if (-not $ContextId) { return }
    if (-not $Known.Contains($ContextId)) { return }
    $Members.Add([PSCustomObject]@{
        ContextExternalId = $ContextId
        MemberExternalId  = $IdentityId
        MemberType        = 'Identity'
    })
}

function Convert-OmadaContextMembers {
    Write-Host "Context members:" -ForegroundColor Cyan
    if (-not $script:emp) {
        Write-Host "  Skipped (Employment.csv not found)" -ForegroundColor Yellow
        return
    }
    $knownContextIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($c in $script:allContexts) { if ($c.ExternalId) { [void]$knownContextIds.Add($c.ExternalId) } }

    $members = [System.Collections.Generic.List[object]]::new()
    foreach ($e in $script:emp) {
        $identId = $e.IDENTITYREF_ID
        if (-not $identId) { continue }

        Add-OmadaContextMember -Members $members -ContextId $e.OUREF_ID -IdentityId $identId -Known $knownContextIds
        Add-OmadaContextMember -Members $members -ContextId $e.JOBTITLE_REF_ID -IdentityId $identId -Known $knownContextIds
        if ($e.OUREF_ID -and $e.JOBTITLE_REF_ID) {
            $posId = "$($e.OUREF_ID)|$($e.JOBTITLE_REF_ID)"
            Add-OmadaContextMember -Members $members -ContextId $posId -IdentityId $identId -Known $knownContextIds
        }
    }
    Write-Out 'ContextMembers.csv' $members.ToArray()
}

# ─── Resources (from Permission-full-details.csv or Permissions.csv) ──
function ConvertTo-OmadaResourceRow {
    param($Row)
    $type = $Row.ROLETYPEREF_VALUE
    if (-not $type) { $type = $Row.ResourceTypeName }
    if ($type -eq 'Business Role') { $type = 'BusinessRole' }
    $sysName = $Row.SYSTEMREF_VALUE
    if (-not $sysName) { $sysName = $Row.SystemName }
    [PSCustomObject]@{
        ExternalId   = if ($Row._UID) { $Row._UID } else { $Row._ID }
        DisplayName  = if ($Row._DISPLAYNAME) { $Row._DISPLAYNAME } else { $Row.DisplayName }
        ResourceType = $type
        Description  = $Row.DESCRIPTION
        SystemName   = $sysName
        Enabled      = if ($Row.RESOURCESTATUS_ENGLISH -eq 'Active' -or $Row.Deleted -ne 'True') { 'true' } else { 'false' }
    }
}

function Convert-OmadaResources {
    Write-Host "Resources:" -ForegroundColor Cyan
    $perm = Read-Src 'Permission-full-details.csv'
    if (-not $perm) { $perm = Read-Src 'Permissions.csv' }
    if (-not $perm) { return }
    Write-Out 'Resources.csv' @($perm | ForEach-Object { ConvertTo-OmadaResourceRow $_ })
}

# ─── ResourceRelationships (from Permission-Nesting.csv) ─────────
function ConvertTo-OmadaRelationshipRow {
    param($Row)
    $parent = if ($Row.ParentUID) { $Row.ParentUID } else { $Row.ParentPermissionID }
    $child  = if ($Row.ChildUID)  { $Row.ChildUID }  else { $Row.ChildPermissionID }
    [PSCustomObject]@{
        ParentExternalId = $parent
        ChildExternalId  = $child
        RelationshipType = 'Contains'
    }
}

function Convert-OmadaResourceRelationships {
    Write-Host "Resource relationships:" -ForegroundColor Cyan
    $nest = Read-Src 'Permission-Nesting.csv'
    if (-not $nest) { return }
    Write-Out 'ResourceRelationships.csv' @($nest | ForEach-Object { ConvertTo-OmadaRelationshipRow $_ } | Where-Object { $_.ParentExternalId -and $_.ChildExternalId })
}

# ─── Users ────────────────────────────────────────────────────────
function ConvertTo-OmadaUserRow {
    param($Row)
    $type = 'User'
    if ($Row.Employee_Type -eq 'Contractor') { $type = 'ExternalUser' }
    [PSCustomObject]@{
        ExternalId        = if ($Row.Employee_ID) { $Row.Employee_ID } else { $Row.EmployeeNumber }
        DisplayName       = if ($Row.Employee_fullname) { $Row.Employee_fullname } else { $Row.DisplayName }
        Email             = $Row.EmailAddress
        PrincipalType     = $type
        JobTitle          = $Row.Job_Title
        Department        = $Row.OU_KEY
        ManagerExternalId = $Row.Managers_CorperateKey
        Enabled           = 'true'
    }
}

function Convert-OmadaUsers {
    Write-Host "Users:" -ForegroundColor Cyan
    $script:users = Read-Src 'Users.csv'
    if (-not $script:users) { return }
    Write-Out 'Users.csv' @($script:users | ForEach-Object { ConvertTo-OmadaUserRow $_ } | Where-Object { $_.ExternalId -and $_.DisplayName })
}

# ─── Assignments (from Account-Permission.csv) ───────────────────
function ConvertTo-OmadaAssignmentRow {
    param($Row)
    $resId = if ($Row.ResouceUID) { $Row.ResouceUID } elseif ($Row.ResourceUID) { $Row.ResourceUID } else { $Row.PermissionID }
    $userId = if ($Row.Employee_ID) { $Row.Employee_ID } else { $Row.AccountID }
    [PSCustomObject]@{
        ResourceExternalId = $resId
        UserExternalId     = $userId
    }
}

function Convert-OmadaAssignments {
    Write-Host "Assignments:" -ForegroundColor Cyan
    $assign = Read-Src 'Account-Permission.csv'
    if (-not $assign) { return }
    Write-Out 'Assignments.csv' @($assign | ForEach-Object { ConvertTo-OmadaAssignmentRow $_ } | Where-Object { $_.ResourceExternalId -and $_.UserExternalId })
}

# ─── Identities ──────────────────────────────────────────────────
function Test-OmadaIdentityIncluded {
    param($Row)
    $t = $Row.IDENTITYTYPE_ENGLISH; if (-not $t) { $t = $Row.IdentityType }
    (-not $t) -or ($t -in @('Primary','Person','Employee'))
}

function ConvertTo-OmadaIdentityRow {
    param($Row)
    [PSCustomObject]@{
        ExternalId = if ($Row._ID) { $Row._ID } elseif ($Row._UID) { $Row._UID } else { $Row._IdentityID }
        DisplayName = if ($Row._DISPLAYNAME) { $Row._DISPLAYNAME } else { $Row.DisplayName }
        Email       = $Row.EMAIL
        EmployeeId  = if ($Row.EMPLOYEEID) { $Row.EMPLOYEEID } else { $Row.EmployeeID }
        Department  = ''
        JobTitle    = $Row.JOBTITLE
    }
}

function Convert-OmadaIdentities {
    Write-Host "Identities:" -ForegroundColor Cyan
    $script:ident = Read-Src 'Identities.csv'
    if (-not $script:ident) { return }
    Write-Out 'Identities.csv' @($script:ident | Where-Object { Test-OmadaIdentityIncluded $_ } | ForEach-Object { ConvertTo-OmadaIdentityRow $_ } | Where-Object { $_.ExternalId -and $_.DisplayName })
}

# ─── IdentityMembers (derived from Identities + Users) ───────────
# The Omada export has no explicit identity-to-account mapping file, but the
# link exists implicitly: Identities.EmployeeID = Users.Employee_ID. We build
# the mapping here so the Identity detail page shows which accounts belong to
# each person.
function Get-OmadaUserIdSet {
    param($Users)
    # The join key is IDENTITYID (on Identities) = Employee_ID (on Users).
    # NOT EmployeeID — that's the HR number which is a different ID space.
    $userIds = @{}
    foreach ($u in $Users) {
        $uid = if ($u.Employee_ID) { $u.Employee_ID } else { $u.EmployeeNumber }
        if ($uid) { $userIds[$uid] = $true }
    }
    return $userIds
}

function ConvertTo-OmadaIdentityMemberRow {
    param($Row)
    # Key identities the SAME way the Identities section does (_ID → _UID →
    # _IdentityID), otherwise a person and their membership row resolve to
    # different deterministic GUIDs and the account→identity link breaks.
    $identId = if ($Row._ID) { $Row._ID } elseif ($Row._UID) { $Row._UID } else { $Row._IdentityID }
    [PSCustomObject]@{
        IdentityExternalId = $identId
        UserExternalId     = $Row.IDENTITYID
        AccountType        = 'Primary'
    }
}

function Convert-OmadaIdentityMembers {
    Write-Host "Identity members:" -ForegroundColor Cyan
    if (-not ($script:ident -and $script:users)) {
        Write-Host "  Skipped (need both Identities.csv and Users.csv)" -ForegroundColor Yellow
        return
    }
    $userIds = Get-OmadaUserIdSet $script:users
    Write-Out 'IdentityMembers.csv' @($script:ident | Where-Object {
        $joinKey = $_.IDENTITYID
        $joinKey -and $userIds.ContainsKey($joinKey)
    } | ForEach-Object { ConvertTo-OmadaIdentityMemberRow $_ } | Where-Object { $_.IdentityExternalId -and $_.UserExternalId })
}

# ─── Certifications (from CRAs.csv) ──────────────────────────────
function ConvertTo-OmadaCertificationRow {
    param($Row)
    $rid = $Row.ResourceId
    $uid = if ($Row.GlobID) { $Row.GlobID } else { $Row.IdentityId }
    [PSCustomObject]@{
        ExternalId           = "$rid|$uid"
        ResourceExternalId   = $rid
        UserDisplayName      = $Row.DisplayName
        Decision             = if ($Row.ComplianceState) { $Row.ComplianceState } else { $Row.Decision }
        ReviewerDisplayName  = $Row.ReviewerDisplayName
        ReviewedDateTime     = ''
    }
}

function Convert-OmadaCertifications {
    Write-Host "Certifications:" -ForegroundColor Cyan
    $cras = Read-Src 'CRAs.csv'
    if (-not $cras) { return }
    Write-Out 'Certifications.csv' @($cras | ForEach-Object { ConvertTo-OmadaCertificationRow $_ } | Where-Object { $_.ExternalId -and $_.ExternalId -ne ([char]'|') })
}

# Orchestrates the full transform in the original section order. Cross-phase
# reads (Employment, Users, Identities) and the built context list are shared
# via $script: scope, exactly as the original script-body variables were.
function Invoke-OmadaTransform {
    Write-Host "`n=== Omada → Identity Atlas Transform ===" -ForegroundColor Cyan
    Write-Host "Source: $SourceFolder"
    Write-Host "Output: $OutputFolder`n"

    Convert-OmadaSystems
    Convert-OmadaContexts
    Convert-OmadaContextMembers
    Convert-OmadaResources
    Convert-OmadaResourceRelationships
    Convert-OmadaUsers
    Convert-OmadaAssignments
    Convert-OmadaIdentities
    Convert-OmadaIdentityMembers
    Convert-OmadaCertifications

    Write-Host "`n=== Transform complete ===" -ForegroundColor Green
    Write-Host "Output folder: $OutputFolder"
    Write-Host "Upload these files to the CSV crawler wizard in Identity Atlas."
}

Invoke-OmadaTransform
