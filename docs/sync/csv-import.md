# CSV Import

Identity Atlas can ingest authorization data from any system that can produce a CSV export — HR platforms, PAM tools, SIEMs, IGA platforms such as Omada or SailPoint, ticketing systems, or custom applications. CSV sync uses the same Ingest API as the Entra ID sync, giving you consistent change tracking, audit history, and IST/SOLL analysis across all your identity sources.

---

## How It Works

In v5, CSV import is **API-driven**. The CSV crawler script (`tools/crawlers/csv/Start-CSVCrawler.ps1`) reads CSV files in the Identity Atlas canonical schema and POSTs them to the Ingest API. Source-specific transformations (e.g., Omada to Identity Atlas format) happen **before** the crawler runs via a separate transform script.

```powershell
.\tools\crawlers\csv\Start-CSVCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc123..." `
    -CsvFolder ".\TransformedData"
```

### Crawler flags

| Flag | Default | Purpose |
|------|---------|---------|
| `-ApiBaseUrl` | Required | Base URL of the Ingest API |
| `-ApiKey` | Required | Crawler API key (`fgc_...`) |
| `-CsvFolder` | Required | Path to folder containing Identity Atlas schema CSV files |
| `-SystemName` | `CSV Import` | Display name for the fallback system |
| `-SystemType` | `CSV` | System type identifier (e.g., `CSV`, `Omada`) |
| `-Delimiter` | `;` | CSV delimiter character |
| `-RefreshViews` | On | Refresh SQL views after sync |

!!! tip
    Columns outside the schema are kept in the entity's `extendedAttributes` for every file except `Assignments.csv`, `IdentityMembers.csv` and `ContextMembers.csv` — see [Extra columns](#extra-columns). You do not need to strip your exports first.

---

## CSV Schema

CSV files must follow the Identity Atlas canonical schema. See [CSV Import Schema](../architecture/csv-import-schema.md) for the full specification.

### Supported entity types

The crawler looks for these files in the CSV folder (filename must match the entity type):

| File | Entity | Target Table |
|------|--------|-------------|
| `Systems.csv` | Systems | Systems |
| `Users.csv` | User/service accounts | Principals |
| `Resources.csv` | Roles, groups, permissions — and business roles (`ResourceType=BusinessRole`) | Resources |
| `Assignments.csv` | Who has access to what | ResourceAssignments |
| `ResourceRelationships.csv` | Resource nesting | ResourceRelationships |
| `Contexts.csv` / `ContextMembers.csv` | Org units, logical applications, other groupings | Contexts + ContextMembers |
| `Identities.csv` / `IdentityMembers.csv` | Real persons and their accounts | Identities + IdentityMembers |
| `Certifications.csv` | Review decisions | CertificationDecisions |

### Key columns per entity

**Systems:**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Stable system identifier |
| `DisplayName` | Yes | Human-readable system name |
| `SystemType` | Yes | Type identifier (e.g. `HR`, `PAM`, `IGA`, `SIEM`) |

**Users (principals):**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Stable principal ID in the source system |
| `DisplayName` | Yes | Full name |
| `Email` | No | Primary email address |
| `PrincipalType` | No | `User`, `ExternalUser`, `SharedMailbox`, etc. Defaults to `User` |
| `Department` | No | Department name |
| `JobTitle` | No | Job title |

**Resources:**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Stable resource ID in the source system |
| `DisplayName` | Yes | Resource name |
| `ResourceType` | No | Type label (e.g. `SharePointSite`, `AppRole`, `DevOpsGroup`) |

**Resource Assignments:**

| Column | Required | Description |
|--------|----------|-------------|
| `ResourceExternalId` | Yes | Matches resource ExternalId |
| `UserExternalId` | Yes | Matches the user's ExternalId |
| `AssignmentType` | No | `Direct` (default), `Indirect` or `Eligible` — the only values ingest accepts |

**Business Roles:**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Stable role ID |
| `DisplayName` | Yes | Role name |
| `CatalogExternalId` | No | Links the role to a GovernanceCatalogs entry |

**Certifications:**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Decision ID |
| `ResourceExternalId` | Yes | Business role or resource being reviewed |
| `PrincipalExternalId` | Yes | Subject of the review |
| `Decision` | Yes | `Approved`, `Denied`, `NotReviewed` |
| `ReviewedDateTime` | No | ISO 8601 timestamp |

---

## CSV Format

All CSV files use **semicolon delimiters** by default (configurable via `-Delimiter`: `;`, `,`, tab or `|`) and expect ISO 8601 format for all date/time values.

### Quoting

Every file is parsed as standard CSV (RFC 4180), so a comma-delimited export whose values are LDAP distinguished names loads correctly as long as those values are quoted:

```csv
ResourceExternalId,UserExternalId
"CN=Finance,OU=Groups,DC=corp,DC=com",u1001
```

A quoted value may contain the delimiter, a doubled quote (`""` for `"`) or a line break. A row the parser cannot resolve — a quote that is never closed, or text after a closing quote — **fails the import** with the file name and line number rather than loading misaligned columns. A failed run never removes existing data.

### Large files

`Assignments.csv` and `Resources.csv` are read and sent in batches, so memory use stays flat whatever their size — tens of millions of assignment rows are fine. The upload limit per file is set by the server (`UPLOAD_MAX_FILE_BYTES`, default 8 GiB) and shown in the wizard. A file can also be copied straight into the crawler's folder on the server; the wizard shows that folder when you edit the crawler, and a copied file is read exactly like an uploaded one.

### Systems

A row's `SystemName` must match a system declared in `Systems.csv` (or the crawler's own system name). A row that names an undeclared system is still loaded, into the crawler's own system — and the job log warns with the number of such rows and the names that were not found. A blank `SystemName` is the normal single-system case and is not reported.

In `ContextMembers.csv` the `SystemName` column is ignored: a membership belongs to its context's system.

### Extra columns

A column outside a file's schema is stored in the entity's `extendedAttributes`, and shown on its detail page, for `Systems`, `Contexts`, `Resources`, `ResourceRelationships`, `Users`, `Identities` and `Certifications`. Blank values are not stored.

Extra columns in `Assignments.csv` are **not** kept: at tens of millions of rows an attribute per assignment costs more than it is worth. `IdentityMembers.csv` and `ContextMembers.csv` have no attribute storage. The job log names any column it ignores.

---

## Source-Specific Transforms

For IGA platforms like Omada or SailPoint, you first transform their native export format into the Identity Atlas canonical schema, then run the CSV crawler. Example transform scripts are in `tools/csv-templates/transforms/`.

```powershell
# Step 1: Transform Omada export to Identity Atlas format
.\tools\csv-templates\transforms\omada-to-identityatlas.ps1 -InputFolder ".\OmadaExport" -OutputFolder ".\TransformedData"

# Step 2: Import transformed data
.\tools\crawlers\csv\Start-CSVCrawler.ps1 -ApiBaseUrl "http://localhost:3001/api" -ApiKey "fgc_abc..." -CsvFolder ".\TransformedData"
```

!!! tip
    Include any additional columns your source system provides. For every file except `Assignments.csv`, `IdentityMembers.csv` and `ContextMembers.csv` they are kept in `extendedAttributes` without schema changes — see [Extra columns](#extra-columns).
