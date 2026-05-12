# Maintenance Backlog

Open items from the Feb 2026 code review. Resolved items have been removed.

---

## PowerShell — Generic Functions

**"All" and "AllToFile" pairs** have 95%+ duplication:
- `Get-FGGroupMemberAll.ps1` / `Get-FGGroupMemberAllToFile.ps1`
- `Get-FGGroupTransitiveMemberAll.ps1` / `Get-FGGroupTransitiveMemberAllToFile.ps1`

Action: merge each pair into one function with optional `-OutputFile` parameter. The 52-line JSON restructuring routine is identical in both "ToFile" functions — extract to a shared helper.

**URI filter building** duplicated across 6+ Get functions (Get-FGUser, Get-FGGroup, Get-FGApplication, Get-FGServicePrincipal, Get-FGCatalog, Get-FGDevice). Consider a shared `Build-FGGraphUri` helper.

**Missing `[cmdletbinding()]`** on: `Get-FGGroupMemberAll`, `Get-FGGroupMemberAllToFile`, `Get-FGGroupTransitiveMemberAll`, `Get-FGGroupTransitiveMemberAllToFile`.

---

## PowerShell — SQL Functions

**Connection management inconsistency** — 2 functions bypass `Invoke-FGSQLCommand`:
- `Write-FGSyncLog.ps1` (lines 98-172): manual connection management
- `New-FGSQLReadOnlyUser.ps1` (lines 103-141): manual connection management

**Shared SQL helpers to extract:**
- `Set-FGSQLTableVersioning -Enable/-Disable` (duplicated in `Add-FGSQLTableColumn` and `Clear-FGSQLTable`)
- `ConvertTo-FGSQLType` / `ConvertTo-FGDotNetType` (duplicated in `Invoke-FGSQLBulkDelete` and `Invoke-FGSQLBulkMerge`)
- Table name parsing with schema (duplicated in `Clear-FGSQLTable` and `Get-FGSQLTableSchema`)

---

## PowerShell — Sync Performance & Reliability

**Missing batching options** (risk `OutOfMemoryException` for large tenants):
- `Sync-FGGroupOwner` — no batching option
- `Sync-FGUser` / `Sync-FGGroup` — no batching for very large tenants

**Retry logic** only exists in `Sync-FGAccessPackageResourceRoleScope`. Move to `Invoke-FGGetRequest` or create `Invoke-FGGetRequestWithRetry` so all sync functions benefit from transient error handling (429, 503, 504).

**Deduplication** only in some sync functions. Add to `Sync-FGUser`, `Sync-FGGroup`, `Sync-FGGroupMember` to prevent MERGE failures.

**No dependency enforcement in Start-FGSync:** GroupMembers can start before Groups completes. Consider sync phases: Phase 1: Users+Groups → Phase 2: memberships → Phase 3: access packages → Phase 4: materialized views.

**Token refresh in runspaces:** `Start-FGSync` gets a token once at start. For 2+ hour syncs, tokens expire (~1 hour). Verify the token check in `Invoke-FGGetRequest` works correctly within runspaces where global state is copied.

---

## PowerShell — Deprecated Patterns

**OAuth2 v1 endpoints** (being deprecated by Microsoft):
- `Get-FGAccessToken.ps1` line 117: `/oauth2/token`
- `Get-FGAccessTokenInteractive.ps1` lines 23, 32
- `Get-FGAccessTokenWithRefreshToken.ps1` line 21

Action: migrate to `/oauth2/v2.0/token`.

---

## PowerShell — Specific/Helper Cleanup

**Confirm-FGGroupMember / Confirm-FGNotGroupMember** share 40+ lines of identical member resolution logic. Extract to `Resolve-FGMemberObjectIds`.

---

## PowerShell — Error Handling

~40+ Generic functions have zero error handling. At minimum, Graph API calls should have try/catch with meaningful error messages.

---

## Node API — Code Quality

- `ensureTagTables` / `ensureCategoryTables` — extract to a shared `ensureTable` utility
- Pagination parameter parsing duplicated across routes
- Inconsistent response formats across endpoints — standardize to `{ data, total, ... }`
- No audit logging for mutations — log user identity + changes for compliance

---

## React UI — Code Duplication

- `TAG_COLORS` array defined 3 times — move to `utils/colors.js`
- `AP_COLORS` array duplicated in `MatrixColumnHeaders.jsx` and `exportToExcel.js`
- Tag operation handlers duplicated in `AccessPackagesPage` — could use `useEntityPage` hook
- Pagination UI duplicated in 3+ pages — extract `PaginationControls` component

## React UI — Architecture

- `MatrixView.jsx` handles data transformation + row reordering + Excel export + rendering — split into data hook + presentation
- Prop drilling: MatrixView (36 props) → MatrixToolbar (21 props) → FilterBar (7 props)

## React UI — Accessibility

- Filter dropdowns use `<div onClick>` instead of `<button>` — not keyboard accessible
- Missing `<label>` elements on search inputs
- No visible focus indicators on custom inputs
- Color-only indicators (AP colors, type badges) need non-color alternatives

---

## PowerShell — Minor Improvements

- `ConvertTo-Json` hardcoded `-Depth 10` in multiple files — use `-Depth 100` to avoid silent truncation
- Base64 padding logic duplicated in `Get-FGAccessTokenDetail.ps1` (header + payload) — extract helper
- Config property navigation duplicated across `Get-FGSecureConfigValue`, `Clear-FGSecureConfigValue`, `Test-FGSecureConfigValue`
- `SecureString` conversion pattern repeated 4× in `Get-FGSecureConfigValue.ps1` — extract `ConvertFrom-SecureStringToPlainText`
- Parameter naming inconsistency in Generic functions: `$id` vs `$Id`, `$DisplayName` vs `$displayName` — standardize to PascalCase
- Device code timeout hardcoded to 300s in `Get-FGAccessTokenInteractive.ps1` — make it a parameter with default
