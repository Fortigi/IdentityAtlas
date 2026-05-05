# PowerShell Functions — Coding Guide

## File Organization

All function files live under `Functions/`:

| Folder | Purpose | Example |
|--------|---------|---------|
| **Base/** | Core HTTP operations, authentication | `Invoke-FGGetRequest.ps1`, `Get-FGAccessToken.ps1` |
| **Generic/** | Direct Microsoft Graph API wrappers (1:1 mapping) | `Get-FGUser.ps1`, `Get-FGGroup.ps1` |
| **Sync/** | Data sync operations | `Sync-FGUser.ps1`, `Start-FGSync.ps1` |
| **Specific/** | Business logic combining multiple functions | `Confirm-FGGroup.ps1` |
| **SQL/** | SQL database operations (legacy, used outside Docker) | `Invoke-FGSQLCommand.ps1` |
| **RiskScoring/** | LLM-assisted risk profiling, batch scoring, clustering | `Invoke-FGRiskScoring.ps1` |

**File naming:** `Verb-FGNoun.ps1` (e.g., `Get-FGGroupMember.ps1`). One function per file.

## Function Naming Convention

- **Prefix:** `FG` (FortigiGraph) for all exported functions
- **Aliases:** Each function has an alias without the `FG` prefix (e.g., `Get-FGGroup` → `Get-Group`)
- **Verbs:** Standard PowerShell verbs (Get, New, Set, Add, Remove, Confirm, Invoke, Connect, Test, Initialize, Sync, Clear, Start)
- **Pattern:** `Verb-FGNoun`

## Function Count by Category

| Category | Count | Purpose |
|----------|-------|---------|
| **Base** | 22 | Authentication, HTTP operations, setup wizard, token management |
| **Generic** | 49 | Graph API CRUD operations |
| **Sync** | 32 | High-performance data sync (Start-FGSync + CSV sync + entity syncs + migration + helpers) |
| **SQL** | 31 | SQL database operations (tables, views, indexes, bulk ops) |
| **Specific** | 9 | High-level idempotent helpers |
| **RiskScoring** | 17 | LLM-assisted risk profiling, batch scoring, cluster analysis, account correlation |

## Function Structure Templates

### Graph API Function Template

```powershell
function Get-FGResource {
    [alias("Get-Resource")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$Id,
        [Parameter(Mandatory = $false)]
        [string]$Filter
    )

    If ($Id) {
        $URI = "https://graph.microsoft.com/beta/resources/$Id"
    } ElseIf ($Filter) {
        $URI = "https://graph.microsoft.com/beta/resources?`$filter=$Filter"
    } Else {
        $URI = "https://graph.microsoft.com/beta/resources"
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}
```

### SQL Function Template

```powershell
function Get-FGSQLResource {
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$Name
    )

    Invoke-FGSQLCommand -ScriptBlock {
        param($connection)
        $cmd = $connection.CreateCommand()
        $cmd.CommandText = "SELECT * FROM dbo.Resources WHERE Name = @Name"
        $cmd.Parameters.AddWithValue("@Name", $Name)
        $reader = $cmd.ExecuteReader()
        # Process results...
        return $results
    }
}
```

## Rules

**DO:**
- Follow existing naming conventions (`Verb-FGNoun`)
- Add aliases without `FG` prefix
- Use `Invoke-FG*Request` functions (never call `Invoke-RestMethod` directly for Graph)
- Use `Invoke-FGSQLCommand` helper for all SQL operations
- Use `/beta` endpoint unless told otherwise
- Use `[cmdletbinding()]` for all functions
- Use color-coded Write-Host for user feedback (Green=success, Yellow=warning, Cyan=progress, Red=error)
- Use `-ErrorAction Stop` with try/catch for Azure operations that must succeed before continuing
- Return raw Graph objects (don't transform)

**DON'T:**
- Don't call `Invoke-RestMethod` directly for Graph (use wrappers)
- Don't manage SQL connections manually (use `Invoke-FGSQLCommand`)
- Don't hardcode credentials or tokens
- Don't create multi-function files
- Don't use `Write-Output` (use `return` directly)
- Don't add comments in Dutch (use English only)
- Don't commit test configuration files (protected by .gitignore)

## When Extending the Module

1. **Check if function already exists:** Search `Functions/` folders first
2. **Determine correct location:**
   - Direct Graph API call → `Functions/Generic/`
   - SQL operation → `Functions/SQL/`
   - Data sync operation → `Functions/Sync/`
   - Risk scoring / LLM / clustering → `Functions/RiskScoring/`
   - Combines multiple operations → `Functions/Specific/`
   - Core HTTP/auth → `Functions/Base/` (rarely needed)
3. **Follow the pattern:** Look at similar existing functions

## Architecture Patterns

### Module Loading

The module loads functions from the `Functions/` directory via dot-sourcing in `FortigiGraph.psm1`. All functions are dot-sourced at import time.

### Global State

**Graph API State:**
- `$Global:AccessToken` — current OAuth access token
- `$Global:ClientId` / `$Global:ClientSecret` / `$Global:TenantId` — app registration
- `$Global:RefreshToken` — refresh token (interactive auth)
- `$Global:DebugMode` — debug flag (`'T'`, `'G'`, `'P'`, `'D'` or combinations)

**SQL State (legacy — Docker uses `DATABASE_URL` env var):**
- `$Global:FGSQLConnectionString` / `$Global:FGSQLServerName` / `$Global:FGSQLDatabaseName`

### The SQL Helper Pattern

**Critical design pattern.** All SQL functions delegate connection lifecycle to `Invoke-FGSQLCommand`:

```powershell
Invoke-FGSQLCommand -ScriptBlock {
    param($connection)
    $cmd = $connection.CreateCommand()
    $cmd.CommandText = "SELECT COUNT(*) FROM Users"
    return $cmd.ExecuteScalar()
}
```

### Pagination (Graph API)

All GET requests automatically handle Microsoft Graph pagination via `Invoke-FGGetRequest`. Never implement manual pagination in callers.

### Authentication in Start-FGSync

`Start-FGSync` always gets a fresh token at the start of every sync run to prevent stale token issues when switching app registrations or after permission updates.

### Debug Mode

```powershell
$Global:DebugMode = 'GP'  # T=Token, G=GET, P=POST/PATCH, D=DELETE
```

### Config File Pattern

The config file (`Config/tenantname.json.template`) drives all operations. All major functions support `-ConfigFile` (only relevant when running crawler scripts outside Docker).

## `principalType` Conventions

The `Principals.principalType` column is NVARCHAR(50). Use these values consistently:

| Value | Description | Source |
|---|---|---|
| `User` | Interactive human user account | `Sync-FGPrincipal`, `Sync-FGCSVPrincipal` |
| `ServicePrincipal` | App registration service principal | `Sync-FGServicePrincipal` |
| `ManagedIdentity` | Azure resource-attached managed identity | `Sync-FGServicePrincipal` |
| `WorkloadIdentity` | Federated credential identity (GitHub Actions, AKS) | `Sync-FGServicePrincipal` / CSV |
| `AIAgent` | AI agent (Copilot Studio, Azure OpenAI, custom) | `Sync-FGServicePrincipal` auto-detection, CSV |
| `ExternalUser` | Guest / B2B account from another tenant | CSV import |
| `SharedMailbox` | Shared mailbox or room/equipment account | CSV import |

**Detection rules in `Sync-FGServicePrincipal`:**
1. `servicePrincipalType = 'ManagedIdentity'` → `ManagedIdentity`
2. Tags contain `CopilotStudio`, `PowerVirtualAgents`, `AzureOpenAI`, or `CognitiveServices` → `AIAgent`
3. `displayName` matches AI patterns (copilot, openai, bot, azure-ai, gpt, etc.) → `AIAgent`
4. Custom `-AINamePatterns` provided → `AIAgent`
5. Default → `ServicePrincipal`

## Graph API Permissions

The Crawlers wizard validates these permissions on the App Registration during setup:

| Permission | ID | Purpose |
|---|---|---|
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Read all users |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` | Read all groups |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` | Read group memberships |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` | Read directory data |
| `Application.Read.All` | `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30` | Read service principals + app role assignments |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup` | `b3a539c9-59be-4c8d-b62c-11ae8c4f2a37` | Read PIM group eligibility schedules |
| `EntitlementManagement.Read.All` | `c74fd47d-ed3c-45c3-9a9e-b8676de685d2` | Read access packages |
| `AccessReview.Read.All` | `d07a8cc0-3d51-4b77-b3b0-32704d1f69fa` | Read access reviews |
| `AuditLog.Read.All` | `b0afded3-3588-46d8-8b3d-9842eff778da` | Read audit/sign-in data |

## Analytical Views

### Group Membership Views (via `Initialize-FGGroupMembershipViews`)

- `vw_GraphGroupMembersRecursive` — all memberships (direct + indirect) with paths via recursive CTE
- `vw_UserPermissionAssignments` — all membership types as separate rows: Owner, Direct, Indirect, Eligible + `managedByAccessPackage` (BIT). No deduplication — a user can have multiple rows per group.

### Access Package Views (via `Initialize-FGAccessPackageViews`)

- `vw_UserPermissionAssignmentViaAccessPackage` — user permissions via access packages
- `vw_DirectGroupMemberships` / `vw_DirectGroupOwnerships`
- `vw_UnmanagedPermissions` — IST vs SOLL gaps
- `vw_AccessPackageAssignmentDetails`, `vw_AccessPackageLastReview`
- `vw_ApprovedRequestTimeline`, `vw_DeniedRequestTimeline`, `vw_PendingRequestTimeline`
- `vw_RequestResponseMetrics` — aggregate approval statistics
