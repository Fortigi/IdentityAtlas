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

Write-Host "`n=== Omada → Identity Atlas Transform ===" -ForegroundColor Cyan
Write-Host "Source: $SourceFolder"
Write-Host "Output: $OutputFolder`n"

# ─── Systems ─────────────────────────────────────────────────────
Write-Host "Systems:" -ForegroundColor Cyan
$sys = Read-Src 'System.csv'
if (-not $sys) { $sys = Read-Src 'Systems.csv' }
if ($sys) {
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
Write-Host "Contexts:" -ForegroundColor Cyan
$allContexts = [System.Collections.Generic.List[object]]::new()

$ou = Read-Src 'Orgunits.csv'
if ($ou) {
    foreach ($r in $ou) {
        $allContexts.Add([PSCustomObject]@{
            ExternalId       = $r.OU_KEY
            DisplayName      = $r.OU_Name
            ContextType      = 'OrgUnit'
            Description      = $r.OU_Description
            ParentExternalId = $r.Parent_OU_Key
        })
    }
}

$jt = Read-Src 'Jobtitle.csv'
if ($jt) {
    foreach ($r in $jt) {
        $allContexts.Add([PSCustomObject]@{
            ExternalId       = $r.JOBTITLE_ID
            DisplayName      = $r.JobTitleName
            ContextType      = 'JobTitle'
            Description      = $r.DESCRIPTION
            ParentExternalId = ''
        })
    }
}

# Employment.csv drives both Position contexts and ContextMembers.
# Read once here so we can iterate twice without re-parsing.
$emp = Read-Src 'Employment.csv'
if ($emp) {
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($e in $emp) {
        if (-not $e.OUREF_ID -or -not $e.JOBTITLE_REF_ID) { continue }
        $posId = "$($e.OUREF_ID)|$($e.JOBTITLE_REF_ID)"
        if ($seen.Add($posId)) {
            $allContexts.Add([PSCustomObject]@{
                ExternalId       = $posId
                DisplayName      = "$($e.OUREF_VALUE) — $($e.JOBTITLE_REF_VALUE)"
                ContextType      = 'Position'
                Description      = ''
                ParentExternalId = $e.OUREF_ID
            })
        }
    }
}

Write-Out 'Contexts.csv' $allContexts.ToArray()

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
Write-Host "Context members:" -ForegroundColor Cyan
if ($emp) {
    $knownContextIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($c in $allContexts) { if ($c.ExternalId) { [void]$knownContextIds.Add($c.ExternalId) } }

    $members = [System.Collections.Generic.List[object]]::new()
    foreach ($e in $emp) {
        $identId = $e.IDENTITYREF_ID
        if (-not $identId) { continue }

        if ($e.OUREF_ID -and $knownContextIds.Contains($e.OUREF_ID)) {
            $members.Add([PSCustomObject]@{
                ContextExternalId = $e.OUREF_ID
                MemberExternalId  = $identId
                MemberType        = 'Identity'
            })
        }
        if ($e.JOBTITLE_REF_ID -and $knownContextIds.Contains($e.JOBTITLE_REF_ID)) {
            $members.Add([PSCustomObject]@{
                ContextExternalId = $e.JOBTITLE_REF_ID
                MemberExternalId  = $identId
                MemberType        = 'Identity'
            })
        }
        if ($e.OUREF_ID -and $e.JOBTITLE_REF_ID) {
            $posId = "$($e.OUREF_ID)|$($e.JOBTITLE_REF_ID)"
            if ($knownContextIds.Contains($posId)) {
                $members.Add([PSCustomObject]@{
                    ContextExternalId = $posId
                    MemberExternalId  = $identId
                    MemberType        = 'Identity'
                })
            }
        }
    }
    Write-Out 'ContextMembers.csv' $members.ToArray()
} else {
    Write-Host "  Skipped (Employment.csv not found)" -ForegroundColor Yellow
}

# ─── Resources (from Permission-full-details.csv or Permissions.csv) ──
Write-Host "Resources:" -ForegroundColor Cyan
$perm = Read-Src 'Permission-full-details.csv'
if (-not $perm) { $perm = Read-Src 'Permissions.csv' }
if ($perm) {
    Write-Out 'Resources.csv' @($perm | ForEach-Object {
        $type = $_.ROLETYPEREF_VALUE
        if (-not $type) { $type = $_.ResourceTypeName }
        if ($type -eq 'Business Role') { $type = 'BusinessRole' }
        $sysName = $_.SYSTEMREF_VALUE
        if (-not $sysName) { $sysName = $_.SystemName }
        [PSCustomObject]@{
            ExternalId   = if ($_._UID) { $_._UID } else { $_._ID }
            DisplayName  = if ($_._DISPLAYNAME) { $_._DISPLAYNAME } else { $_.DisplayName }
            ResourceType = $type
            Description  = $_.DESCRIPTION
            SystemName   = $sysName
            Enabled      = if ($_.RESOURCESTATUS_ENGLISH -eq 'Active' -or $_.Deleted -ne 'True') { 'true' } else { 'false' }
        }
    })
}

# ─── ResourceRelationships (from Permission-Nesting.csv) ─────────
Write-Host "Resource relationships:" -ForegroundColor Cyan
$nest = Read-Src 'Permission-Nesting.csv'
if ($nest) {
    Write-Out 'ResourceRelationships.csv' @($nest | ForEach-Object {
        $parent = if ($_.ParentUID) { $_.ParentUID } else { $_.ParentPermissionID }
        $child  = if ($_.ChildUID)  { $_.ChildUID }  else { $_.ChildPermissionID }
        [PSCustomObject]@{
            ParentExternalId = $parent
            ChildExternalId  = $child
            RelationshipType = 'Contains'
        }
    } | Where-Object { $_.ParentExternalId -and $_.ChildExternalId })
}

# ─── Users ────────────────────────────────────────────────────────
Write-Host "Users:" -ForegroundColor Cyan
$users = Read-Src 'Users.csv'
if ($users) {
    Write-Out 'Users.csv' @($users | ForEach-Object {
        $type = 'User'
        if ($_.Employee_Type -eq 'Contractor') { $type = 'ExternalUser' }
        [PSCustomObject]@{
            ExternalId        = if ($_.Employee_ID) { $_.Employee_ID } else { $_.EmployeeNumber }
            DisplayName       = if ($_.Employee_fullname) { $_.Employee_fullname } else { $_.DisplayName }
            Email             = $_.EmailAddress
            PrincipalType     = $type
            JobTitle          = $_.Job_Title
            Department        = $_.OU_KEY
            ManagerExternalId = $_.Managers_CorperateKey
            Enabled           = 'true'
        }
    } | Where-Object { $_.ExternalId -and $_.DisplayName })
}

# ─── Assignments (from Account-Permission.csv) ───────────────────
Write-Host "Assignments:" -ForegroundColor Cyan
$assign = Read-Src 'Account-Permission.csv'
if ($assign) {
    Write-Out 'Assignments.csv' @($assign | ForEach-Object {
        $resId = if ($_.ResouceUID) { $_.ResouceUID } elseif ($_.ResourceUID) { $_.ResourceUID } else { $_.PermissionID }
        $userId = if ($_.Employee_ID) { $_.Employee_ID } else { $_.AccountID }
        [PSCustomObject]@{
            ResourceExternalId = $resId
            UserExternalId     = $userId
        }
    } | Where-Object { $_.ResourceExternalId -and $_.UserExternalId })
}

# ─── Identities ──────────────────────────────────────────────────
Write-Host "Identities:" -ForegroundColor Cyan
$ident = Read-Src 'Identities.csv'
if ($ident) {
    Write-Out 'Identities.csv' @($ident | Where-Object {
        $t = $_.IDENTITYTYPE_ENGLISH; if (-not $t) { $t = $_.IdentityType }
        (-not $t) -or ($t -in @('Primary','Person','Employee'))
    } | ForEach-Object {
        [PSCustomObject]@{
            ExternalId = if ($_._ID) { $_._ID } elseif ($_._UID) { $_._UID } else { $_._IdentityID }
            DisplayName = if ($_._DISPLAYNAME) { $_._DISPLAYNAME } else { $_.DisplayName }
            Email       = $_.EMAIL
            EmployeeId  = if ($_.EMPLOYEEID) { $_.EMPLOYEEID } else { $_.EmployeeID }
            Department  = ''
            JobTitle    = $_.JOBTITLE
        }
    } | Where-Object { $_.ExternalId -and $_.DisplayName })
}

# ─── IdentityMembers (derived from Identities + Users) ───────────
# The Omada export has no explicit identity-to-account mapping file, but the
# link exists implicitly: Identities.EmployeeID = Users.Employee_ID. We build
# the mapping here so the Identity detail page shows which accounts belong to
# each person.
Write-Host "Identity members:" -ForegroundColor Cyan
if ($ident -and $users) {
    # The join key is IDENTITYID (on Identities) = Employee_ID (on Users).
    # NOT EmployeeID — that's the HR number which is a different ID space.
    $userIds = @{}
    foreach ($u in $users) {
        $uid = if ($u.Employee_ID) { $u.Employee_ID } else { $u.EmployeeNumber }
        if ($uid) { $userIds[$uid] = $true }
    }
    Write-Out 'IdentityMembers.csv' @($ident | Where-Object {
        $joinKey = $_.IDENTITYID
        $joinKey -and $userIds.ContainsKey($joinKey)
    } | ForEach-Object {
        # Key identities the SAME way the Identities section does (_ID → _UID →
        # _IdentityID), otherwise a person and their membership row resolve to
        # different deterministic GUIDs and the account→identity link breaks.
        $identId = if ($_._ID) { $_._ID } elseif ($_._UID) { $_._UID } else { $_._IdentityID }
        [PSCustomObject]@{
            IdentityExternalId = $identId
            UserExternalId     = $_.IDENTITYID
            AccountType        = 'Primary'
        }
    } | Where-Object { $_.IdentityExternalId -and $_.UserExternalId })
} else {
    Write-Host "  Skipped (need both Identities.csv and Users.csv)" -ForegroundColor Yellow
}

# ─── Certifications (from CRAs.csv) ──────────────────────────────
Write-Host "Certifications:" -ForegroundColor Cyan
$cras = Read-Src 'CRAs.csv'
if ($cras) {
    Write-Out 'Certifications.csv' @($cras | ForEach-Object {
        $rid = $_.ResourceId
        $uid = if ($_.GlobID) { $_.GlobID } else { $_.IdentityId }
        [PSCustomObject]@{
            ExternalId           = "$rid|$uid"
            ResourceExternalId   = $rid
            UserDisplayName      = $_.DisplayName
            Decision             = if ($_.ComplianceState) { $_.ComplianceState } else { $_.Decision }
            ReviewerDisplayName  = $_.ReviewerDisplayName
            ReviewedDateTime     = ''
        }
    } | Where-Object { $_.ExternalId -and $_.ExternalId -ne ([char]'|') })
}

Write-Host "`n=== Transform complete ===" -ForegroundColor Green
Write-Host "Output folder: $OutputFolder"
Write-Host "Upload these files to the CSV crawler wizard in Identity Atlas."
