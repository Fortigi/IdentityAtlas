# CSV Import Schema

## Design principle

Identity Atlas defines **one canonical CSV schema** per entity type. Column names, types, and relationships are fixed and documented. The crawler reads exactly this format — no column-name guessing, no aliases, no auto-detection.

Source-specific transformation (Omada → Identity Atlas, SAP → Identity Atlas, ServiceNow → Identity Atlas) happens **before import** via a lightweight pre-import script. Identity Atlas owns the target schema, the user owns the source mapping. This separation keeps the crawler simple and testable.

### CSV files and their schemas

Every file is **semicolon-delimited, UTF-8 with BOM** (matching the de facto standard for European CSV exports). The delimiter is configurable per crawler config.

All files are **optional** — import only what your source system has. The minimum viable import is: `Resources.csv` + `Users.csv` + `Assignments.csv`. Everything else adds depth.

#### 1. `Systems.csv` (optional)

Defines the authorization systems. If omitted, all data is scoped to the single system defined in Step 1 of the wizard.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | Unique identifier in the source (used as dedup key) |
| `DisplayName` | string | yes | Human-readable name (e.g. "SAP ERP", "Active Directory") |
| `SystemType` | string | no | Grouping label (e.g. "SAP", "AD", "ServiceNow"). Defaults to the wizard's System Type if omitted |
| `Description` | string | no | Free text |

Extra columns are stored in `extendedAttributes` JSON.

#### 2. `Resources.csv` (required)

Permissions, roles, groups, apps — anything a user can be assigned to.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | Unique identifier in the source system |
| `DisplayName` | string | yes | Human-readable name |
| `ResourceType` | string | no | Classification: `EntraGroup`, `SAPRole`, `BusinessRole`, `ApplicationRole`, etc. Free-form; `BusinessRole` has special treatment (shown on the Business Roles page) |
| `Description` | string | no | Free text |
| `SystemName` | string | no | Must match a `DisplayName` from `Systems.csv` or the wizard's system name. Omit when all resources belong to the same system |
| `Enabled` | bool | no | `true`/`false`. Default: `true` |

Extra columns → `extendedAttributes`.

#### 3. `Users.csv` (required)

People, service accounts, bots — anything that can hold permissions.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | Unique identifier (employee number, sAMAccountName, etc.) |
| `DisplayName` | string | yes | Full name |
| `Email` | string | no | Primary email / UPN |
| `PrincipalType` | string | no | One of: `User`, `ServicePrincipal`, `ExternalUser`, `SharedMailbox`. Default: `User` |
| `JobTitle` | string | no | |
| `Department` | string | no | Used to derive OrgUnit contexts when no `Contexts.csv` is provided |
| `ManagerExternalId` | string | no | ExternalId of the manager (for org-chart hierarchy) |
| `SystemName` | string | no | Like Resources — links to a system. Omit for single-system imports |
| `Enabled` | bool | no | `true`/`false`. Default: `true` |

Extra columns → `extendedAttributes`.

#### 4. `Assignments.csv` (required)

Who has access to what.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ResourceExternalId` | string | yes | Must match an `ExternalId` from `Resources.csv` |
| `UserExternalId` | string | yes | Must match an `ExternalId` from `Users.csv` |
| `AssignmentType` | string | no | `Direct` (default), `Governed`, `Eligible`, `Owner`. Assignments to `BusinessRole` resources are automatically treated as `Governed` if this column is omitted or set to `Direct` |
| `SystemName` | string | no | Scopes the assignment. Omit for single-system |

Extra columns → `extendedAttributes`.

#### 5. `ResourceRelationships.csv` (optional)

Parent–child links between resources (role nesting, group membership, business-role contains permission).

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ParentExternalId` | string | yes | ExternalId of the parent resource |
| `ChildExternalId` | string | yes | ExternalId of the child resource |
| `RelationshipType` | string | no | `Contains` (default), `GrantsAccessTo` |
| `SystemName` | string | no | |

#### 6. `Contexts.csv` (optional)

Organisational units, departments, cost centres. If omitted, contexts are derived automatically from `Users.csv → Department` column.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | |
| `DisplayName` | string | yes | |
| `ContextType` | string | no | `Department` (default), `CostCenter`, `Division`, `Team` |
| `Description` | string | no | |
| `ParentExternalId` | string | no | For hierarchical org structures |
| `SystemName` | string | no | |

#### 7. `Identities.csv` (optional)

Real persons (as opposed to accounts). Used when one person has multiple accounts across systems.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | |
| `DisplayName` | string | yes | |
| `Email` | string | no | |
| `EmployeeId` | string | no | HR employee number |
| `Department` | string | no | |
| `JobTitle` | string | no | |

#### 8. `IdentityMembers.csv` (optional)

Links identities to their accounts (principals). Required when `Identities.csv` is provided and you want to show which accounts belong to which person.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `IdentityExternalId` | string | yes | Must match an `ExternalId` from `Identities.csv` |
| `UserExternalId` | string | yes | Must match an `ExternalId` from `Users.csv` |
| `AccountType` | string | no | `Primary`, `Secondary`, `Service`, `Admin` |

#### 9. `Certifications.csv` (optional)

Access review / certification decisions.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `ExternalId` | string | yes | Unique ID of the decision |
| `ResourceExternalId` | string | no | The resource being reviewed |
| `UserDisplayName` | string | no | Who was reviewed |
| `Decision` | string | no | `Approved`, `Denied`, `NotReviewed`, etc. |
| `ReviewerDisplayName` | string | no | Who made the decision |
| `ReviewedDateTime` | datetime | no | ISO 8601 |

### Key design decisions

**1. ExternalId is the dedup key, not UUID**

Every entity uses `ExternalId` as its natural key. Identity Atlas generates deterministic UUIDs from `<SystemType>-<EntityType>:<ExternalId>`. Users never need to generate or know about UUIDs. Re-importing the same file is idempotent.

**2. Cross-file references use ExternalId**

`Assignments.csv` references resources and users by their `ExternalId`, not by UUID. The normalization layer resolves these to deterministic UUIDs using the same prefix. This means:
- No pre-processing step to look up UUIDs
- Files can be generated independently
- Order of import doesn't matter (the crawler imports in the right order)

**3. SystemName is optional everywhere**

For single-system imports (the common case), omit `SystemName` from all files. Everything goes to the system defined in Step 1 of the wizard. For multi-system imports, add a `SystemName` column to any file where entities belong to different systems. Unrecognised or blank values fall back to the wizard system.

**4. BusinessRole assignment auto-classification**

When `AssignmentType` is `Direct` or omitted, but the target resource has `ResourceType = 'BusinessRole'`, the system automatically reclassifies the assignment as `Governed`. This means Omada-style exports (where all assignments are "Direct") work correctly on the Business Roles page without the user having to manually tag governed assignments.

**5. Extra columns become extendedAttributes**

Any column not in the schema above is silently stored as JSON in the entity's `extendedAttributes` field. This means:
- Source-specific fields (Omada's `ODWBusiKey`, SAP's `AGR_NAME`) are preserved
- The UI can show them on detail pages under "Extended Attributes"
- No data is lost during import
- No schema changes needed to support new source fields

### Minimum viable imports

| Scenario | Files needed |
|----------|-------------|
| **Basic permission review** | `Resources.csv` + `Users.csv` + `Assignments.csv` |
| **With org structure** | + `Contexts.csv` (or just `Department` column in `Users.csv`) |
| **Multi-system** | + `Systems.csv` + `SystemName` column in other files |
| **With identity correlation** | + `Identities.csv` + `IdentityMembers.csv` |
| **With access reviews** | + `Certifications.csv` |
| **With role hierarchy** | + `ResourceRelationships.csv` |
| **Full model** | All 9 files |

### Pre-import transformation

For each source system, the user writes a small transformation script that maps their column names to the Identity Atlas schema. We provide templates:

```
tools/
  csv-templates/
    schema/                      ← empty CSV files with just headers (the spec)
      Systems.csv
      Resources.csv
      Users.csv
      Assignments.csv
      ResourceRelationships.csv
      Contexts.csv
      Identities.csv
      IdentityMembers.csv
      Certifications.csv
    transforms/                  ← example transformation scripts
      omada-to-identityatlas.ps1
      entra-export-to-identityatlas.ps1
      generic-template.ps1
```

Example Omada transform (the "pre-import script"):

```powershell
# Transform Omada Identity exports → Identity Atlas CSV schema
param([string]$SourceFolder, [string]$OutputFolder)

# Systems
Import-Csv "$SourceFolder/System.csv" -Delimiter ";" |
  Select-Object @{N='ExternalId';E={$_._ID}},
                @{N='DisplayName';E={$_._DISPLAYNAME}},
                @{N='Description';E={$_.DESCRIPTION}} |
  Export-Csv "$OutputFolder/Systems.csv" -Delimiter ";" -NoTypeInformation

# Resources
Import-Csv "$SourceFolder/Permission-full-details.csv" -Delimiter ";" |
  Select-Object @{N='ExternalId';E={$_._UID}},
                @{N='DisplayName';E={$_._DISPLAYNAME}},
                @{N='ResourceType';E={$_.ROLETYPEREF_VALUE}},
                @{N='Description';E={$_.DESCRIPTION}},
                @{N='SystemName';E={$_.SYSTEMREF_VALUE}},
                @{N='Enabled';E={$_.RESOURCESTATUS_ENGLISH -eq 'Active'}} |
  Export-Csv "$OutputFolder/Resources.csv" -Delimiter ";" -NoTypeInformation

# Users
Import-Csv "$SourceFolder/Users.csv" -Delimiter ";" |
  Select-Object @{N='ExternalId';E={$_.Employee_ID}},
                @{N='DisplayName';E={$_.Employee_fullname}},
                @{N='PrincipalType';E={if($_.Employee_Type -eq 'Employee'){'User'}else{'ExternalUser'}}},
                @{N='Department';E={$_.OU_KEY}},
                @{N='JobTitle';E={$_.Job_Title}},
                @{N='ManagerExternalId';E={$_.Managers_CorperateKey}} |
  Export-Csv "$OutputFolder/Users.csv" -Delimiter ";" -NoTypeInformation

# Assignments
Import-Csv "$SourceFolder/Account-Permission.csv" -Delimiter ";" |
  Select-Object @{N='ResourceExternalId';E={$_.ResouceUID}},
                @{N='UserExternalId';E={$_.Employee_ID}} |
  Export-Csv "$OutputFolder/Assignments.csv" -Delimiter ";" -NoTypeInformation
```

This is ~30 lines per source system, easily auditable, and keeps Identity Atlas clean.

### Implementation details

| Component | What it does |
|-----------|-------------|
| **CSV crawler** (`tools/crawlers/csv/Start-CSVCrawler.ps1`) | Reads exactly the schema column names. `Assert-Columns` validates required columns upfront with clear error messages. No `Get-Col` fallback logic. |
| **Validation** (`app/api/src/ingest/validation.js`) | `requiredOneOf` supports both UUID and ExternalId forms (e.g. `resourceId` or `resourceExternalId`). |
| **Normalization** (`app/api/src/ingest/normalization.js`) | Converts `*ExternalId` fields to deterministic UUIDs using `${sysPrefix}-resources` / `${sysPrefix}-principals` / `${sysPrefix}-identities` prefixes. |
| **File slots** (`app/api/src/routes/csvUploads.js`) | 9 slots matching the schema files. Schema headers embedded for the download endpoint. |
| **UI wizard** (`app/ui/src/components/CrawlersPage.jsx`) | Updated slot labels + tooltips. "Download schema templates" link in the upload step. |
| **Schema templates** (`tools/csv-templates/schema/*.csv`) | Header-only CSV files — the canonical spec. |
| **Omada transform** (`tools/csv-templates/transforms/omada-to-identityatlas.ps1`) | Example transform: ~160 lines mapping Omada columns to Identity Atlas schema. |
| **Auto-classify** (`POST /api/ingest/classify-business-role-assignments`) | Post-import: reclassifies Direct assignments to BusinessRole resources as Governed. |
| **Backpressure fix** (`app/api/src/ingest/engine.js`, `sessions.js`) | `pg-copy-streams` COPY FROM STDIN now respects write backpressure. |

### Design rules

- No column-name guessing or auto-detection in the crawler
- No source-specific logic in the crawler
- One schema, clearly documented — user transforms their data to match
- Extra columns preserved automatically in `extendedAttributes` (no data loss)
- Subset imports supported (only provide what your source has)
- Multi-system supported via optional `SystemName` column

### Using the Omada transform

```powershell
# Transform Omada exports to Identity Atlas schema
pwsh tools/csv-templates/transforms/omada-to-identityatlas.ps1 `
    -SourceFolder ./OmadaExport -OutputFolder ./ForImport

# Upload the transformed files to the CSV crawler wizard in the UI
```

To support a new source system, copy the Omada transform and adapt the column mappings. The crawler and Identity Atlas schema stay stable.
