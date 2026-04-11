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
    Columns not explicitly mapped are automatically collected into the `extendedAttributes` JSON column. You do not need to pre-process or strip your exports — just pass the file as-is.

---

## CSV Schema

CSV files must follow the Identity Atlas canonical schema. See [CSV Import Schema](../architecture/csv-import-schema.md) for the full specification.

### Supported entity types

The crawler looks for these files in the CSV folder (filename must match the entity type):

| File | Entity | Target Table |
|------|--------|-------------|
| `systems.csv` | Systems | Systems |
| `principals.csv` | User/service accounts | Principals |
| `resources.csv` | Roles, groups, permissions | Resources |
| `assignments.csv` | Who has access to what | ResourceAssignments |
| `business-roles.csv` | Business roles | Resources (`resourceType='BusinessRole'`) |
| `identities.csv` | Real persons | Identities + IdentityMembers |
| `certifications.csv` | Review decisions | CertificationDecisions |

### Key columns per entity

**Systems:**

| Column | Required | Description |
|--------|----------|-------------|
| `ExternalId` | Yes | Stable system identifier |
| `DisplayName` | Yes | Human-readable system name |
| `SystemType` | Yes | Type identifier (e.g. `HR`, `PAM`, `IGA`, `SIEM`) |

**Principals:**

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
| `PrincipalExternalId` | Yes | Matches principal ExternalId |
| `AssignmentType` | No | `Direct`, `Governed`, `Eligible`, etc. Defaults to `Direct` |

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

All CSV files use **semicolon delimiters** by default (configurable via `-Delimiter`) and expect ISO 8601 format for all date/time values.

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
    Include any additional columns your source system provides. They will be collected into the `extendedAttributes` JSON column automatically, preserving all context without requiring schema changes.
