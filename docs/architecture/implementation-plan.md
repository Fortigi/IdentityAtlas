# Ingest API — Implementation Plan

Step-by-step guide for migrating from the current direct-SQL sync architecture to the Ingest API architecture described in [Ingest API](ingest-api.md).

Each phase builds on the previous one. A phase is complete when its validation criteria pass.

---

## Phase 0: Crawler Authentication & Admin UI

**Goal:** Crawlers can register, authenticate, and rotate keys — before any ingest logic exists.

### Backend

- [ ] Create `Initialize-FGCrawlerTables.ps1` in `Functions/SQL/`
    - `Crawlers` table: `id`, `displayName`, `description`, `apiKeyHash`, `apiKeySalt`, `apiKeyPrefix`, `systemIds` (JSON), `permissions` (JSON), `enabled`, `createdAt`, `createdBy`, `lastUsedAt`, `lastRotatedAt`, `expiresAt`, `rateLimit`
    - `CrawlerAuditLog` table: `id`, `crawlerId`, `action`, `endpoint`, `recordCount`, `statusCode`, `ipAddress`, `timestamp`
- [ ] Create `middleware/crawlerAuth.js` in `UI/backend/src/`
    - Extract API key from `Authorization: Bearer fgc_...` header
    - Look up by `apiKeyPrefix` (first 8 chars), verify SHA-256 hash against stored `apiKeyHash` + `apiKeySalt`
    - Check `enabled`, `expiresAt`, `systemIds` scope
    - Per-crawler rate limiting (in-memory sliding window, using `rateLimit` from DB)
    - Set `req.crawler` with crawler metadata on success
    - Write to `CrawlerAuditLog` on every auth attempt
- [ ] Create `routes/crawlers.js` in `UI/backend/src/routes/`
    - `GET /api/admin/crawlers` — list all crawlers (Entra ID auth, no keys in response)
    - `POST /api/admin/crawlers` — register crawler, generate `fgc_` key, return plaintext **once**, store hash
    - `PATCH /api/admin/crawlers/:id` — update displayName, description, enabled, systemIds, permissions
    - `DELETE /api/admin/crawlers/:id` — soft-delete (set `enabled = 0`)
    - `GET /api/admin/crawlers/:id/audit` — paginated audit log
    - `POST /api/admin/crawlers/:id/reset` — admin key reset, return new key
    - `POST /api/crawlers/rotate` — crawler self-service key rotation (crawlerAuth)
    - `GET /api/crawlers/whoami` — return own metadata (crawlerAuth)
- [ ] Register routes in `index.js`
    - `/api/admin/crawlers` → Entra ID auth middleware
    - `/api/crawlers` → crawlerAuth middleware
- [ ] Call `Initialize-FGCrawlerTables` from `Start-FGSync` table initialization block

### Frontend

- [ ] Create `CrawlersPage.jsx` in `UI/frontend/src/components/`
    - Table listing crawlers: name, prefix, systems, enabled, last used, created
    - "Register Crawler" dialog: name, description, system scope, permissions → shows key **once** with copy button
    - Enable/disable toggle per crawler
    - "Reset Key" button with confirmation
    - Expandable audit log per crawler
- [ ] Add "Crawlers" tab to admin section in `App.jsx`

### Validation

- [ ] Register a crawler via the admin UI → key displayed once
- [ ] `GET /api/crawlers/whoami` with the key → returns crawler metadata
- [ ] `POST /api/crawlers/rotate` → old key stops working, new key works
- [ ] Disabled crawler → 403
- [ ] Expired crawler → 401
- [ ] Rate limit exceeded → 429
- [ ] Wrong system scope (tested in Phase 2) → 403

---

## Phase 1: Ingest Engine Core

**Goal:** The bulk merge + scoped delete logic works in JavaScript, matching the PowerShell implementation.

### Engine

- [ ] Create `ingest/engine.js` in `UI/backend/src/`
    - `async merge(pool, tableName, keyColumns, records, options)` — core function:
        1. Create `##TempIngest_<uuid>` table matching target schema (query `INFORMATION_SCHEMA.COLUMNS`)
        2. `mssql` Table + BulkLoad records into temp table
        3. Generate and execute MERGE statement (WHEN MATCHED UPDATE, WHEN NOT MATCHED INSERT, OUTPUT $action)
        4. Return `{ inserted, updated }`
    - `async scopedDelete(pool, tableName, keyColumns, tempTable, systemId, scope)` — delete detection:
        1. Build DELETE with `WHERE systemId = @systemId` + optional scope filters (`resourceType`, `assignmentType`, etc.)
        2. Add `AND ValidTo = '9999-12-31 23:59:59.9999999'`
        3. Add `AND NOT EXISTS (SELECT 1 FROM <tempTable> WHERE ...)`
        4. Return `{ deleted }`
    - `async ingest(pool, tableName, keyColumns, systemId, records, options)` — orchestrator:
        1. Call `merge()`
        2. If `syncMode === 'full'`: call `scopedDelete()`
        3. Write to `GraphSyncLog`
        4. Drop temp table
        5. Return combined result
- [ ] Create `ingest/normalization.js`
    - Type coercion: strings to correct SQL types, booleans, dates
    - Deterministic GUID generation: `MD5(prefix + ":" + externalId)` as UUID v3
    - `extendedAttributes` packing: move non-core fields into JSON column
- [ ] Create `ingest/validation.js`
    - JSON Schema validation per entity type using `ajv`
    - Validate `systemId` exists in Systems table
    - Validate `systemId` is in crawler's allowed systems
    - Validate required fields, max lengths, enum values
- [ ] Create `ingest/sessions.js`
    - Track active sync sessions in memory: `Map<syncId, { tempTable, tableName, systemId, startedAt }>`
    - `start`: create temp table, merge first batch
    - `continue`: merge into existing temp table
    - `end`: merge final batch, run scoped delete, cleanup
    - Auto-expire sessions after 30 minutes
    - Cleanup stale temp tables on server startup
- [ ] Create JSON Schema files in `ingest/schemas/`
    - `system.schema.json`
    - `principal.schema.json`
    - `resource.schema.json`
    - `resourceAssignment.schema.json`
    - `resourceRelationship.schema.json`
    - `identity.schema.json`
    - `identityMember.schema.json`
    - `context.schema.json`
    - `governanceCatalog.schema.json`
    - `assignmentPolicy.schema.json`
    - `assignmentRequest.schema.json`
    - `certificationDecision.schema.json`

### Validation

- [ ] Unit test: merge 100 records into empty table → 100 inserted, 0 updated
- [ ] Unit test: merge same 100 records again → 0 inserted, 100 updated
- [ ] Unit test: merge 100 records, change 10 → 0 inserted, 10 updated (only changed rows)
- [ ] Unit test: full sync with 90 of 100 records → 10 deleted, temporal history preserved
- [ ] Unit test: delta sync with 10 of 100 records → 0 deleted
- [ ] Unit test: system A sync does NOT delete system B's records
- [ ] Unit test: scope filter `resourceType='Group'` does NOT delete `resourceType='AppRole'`
- [ ] Unit test: composite key delete (ResourceAssignments) matches on all 3 key columns
- [ ] Unit test: deterministic GUID for same input → same output every time
- [ ] Unit test: chunked session (start + 2 continue + end) produces same result as single batch

---

## Phase 2: Ingest Endpoints

**Goal:** All 12 entity endpoints are live and accept data from authenticated crawlers.

### Routes

- [ ] Create `routes/ingest.js` in `UI/backend/src/routes/`
- [ ] Register in `index.js` with crawlerAuth middleware and `express.json({ limit: '10mb' })`
- [ ] Implement each endpoint (all follow the same pattern — delegate to engine):

**Core entity endpoints:**

- [ ] `POST /api/ingest/systems` — target: `Systems`, key: `id` (auto-assigned INT), return allocated IDs
- [ ] `POST /api/ingest/principals` — target: `Principals`, key: `id`, scope: `principalType`
- [ ] `POST /api/ingest/resources` — target: `Resources`, key: `id`, scope: `resourceType`
- [ ] `POST /api/ingest/resource-assignments` — target: `ResourceAssignments`, key: `(resourceId, principalId, assignmentType)`, scope: `assignmentType`
- [ ] `POST /api/ingest/resource-relationships` — target: `ResourceRelationships`, key: `(parentResourceId, childResourceId, relationshipType)`, scope: `relationshipType`
- [ ] `POST /api/ingest/identities` — target: `Identities`, key: `id`
- [ ] `POST /api/ingest/identity-members` — target: `IdentityMembers`, key: `(identityId, principalId)`
- [ ] `POST /api/ingest/contexts` — target: `Contexts`, key: `id`, scope: `contextType`

**Governance endpoints:**

- [ ] `POST /api/ingest/governance/catalogs` — target: `GovernanceCatalogs`, key: `id`
- [ ] `POST /api/ingest/governance/policies` — target: `AssignmentPolicies`, key: `id`
- [ ] `POST /api/ingest/governance/requests` — target: `AssignmentRequests`, key: `id`
- [ ] `POST /api/ingest/governance/certifications` — target: `CertificationDecisions`, key: `id`

**Utility endpoints:**

- [ ] `POST /api/ingest/refresh-views` — trigger materialized view refresh (requires `refreshViews` permission)

### Validation

- [ ] curl: POST 10 principals with valid key → 201, data visible in SQL
- [ ] curl: POST to wrong system scope → 403
- [ ] curl: POST with missing required field → 400 with field-level error
- [ ] curl: POST with invalid enum value (e.g. `principalType: "Banana"`) → 400
- [ ] curl: full sync 100 resources, then full sync 90 → 10 deleted in SQL
- [ ] curl: delta sync 10 of 100 → 0 deleted
- [ ] curl: chunked session (3 batches) → correct final count
- [ ] curl: deterministic GUID mode → same IDs on repeat sync
- [ ] Verify `GraphSyncLog` has entry for each ingest call
- [ ] Verify temporal history: update a record, check history table has old version
- [ ] Verify data is visible in existing UI (matrix, resources page, etc.)

---

## Phase 3: OpenAPI Spec & Swagger

**Goal:** API is self-documenting; clients can be auto-generated.

- [ ] Write `openapi.yaml` in `UI/backend/src/` (hand-written, source of truth)
    - All 12 ingest endpoints with request/response schemas
    - Crawler auth endpoints
    - Admin crawler endpoints
    - Security schemes (Bearer token for crawlers, Bearer JWT for Entra ID)
- [ ] Add `swagger-ui-express` and `yamljs` to `package.json`
- [ ] Serve Swagger UI at `GET /api/docs`
- [ ] Serve raw spec at `GET /api/docs/openapi.json`
- [ ] Add spec validation to CI (optional): ensure spec matches actual routes

### Validation

- [ ] Open `/api/docs` in browser → interactive Swagger UI loads
- [ ] "Try it out" on an endpoint → works with a real API key
- [ ] Generate PowerShell client: `openapi-generator-cli generate -i openapi.json -g powershell`
- [ ] Generated client compiles and can call `/api/crawlers/whoami`

---

## Phase 4: EntraID Crawler

**Goal:** A standalone crawler replaces `Start-FGSync` for Entra ID data, producing identical results.

### Crawler scripts

Create `Crawlers/EntraID/` folder:

- [ ] `Start-EntraIDCrawler.ps1` — orchestrator:
    1. Load config (API URL, crawler key, Graph credentials)
    2. `GET /api/crawlers/whoami` to verify connectivity
    3. Register/get system via `POST /api/ingest/systems`
    4. Call each sync script in dependency order
    5. `POST /api/ingest/refresh-views`
    6. Report summary
- [ ] `Sync-EntraIDPrincipals.ps1`
    - Fetch users from Graph API (reuse `Invoke-FGGetRequest` pagination logic)
    - Map Graph fields to Principals schema (core columns + extendedAttributes JSON)
    - POST to `/api/ingest/principals` in batches of 10,000 (sync sessions for larger sets)
    - `syncMode: "full"`, `scope: { principalType: "User" }`
- [ ] `Sync-EntraIDServicePrincipals.ps1`
    - Fetch service principals, classify as ServicePrincipal/ManagedIdentity/AIAgent
    - POST to `/api/ingest/principals`
    - `scope: { principalType: "ServicePrincipal" }` (plus ManagedIdentity, AIAgent)
- [ ] `Sync-EntraIDResources.ps1`
    - Fetch groups → POST to `/api/ingest/resources` with `scope: { resourceType: "EntraGroup" }`
    - Fetch directory roles → POST with `scope: { resourceType: "EntraDirectoryRole" }`
    - Fetch app roles → POST with `scope: { resourceType: "EntraAppRole" }`
- [ ] `Sync-EntraIDAssignments.ps1`
    - Fetch group memberships → POST to `/api/ingest/resource-assignments` with `scope: { assignmentType: "Direct" }`
    - Fetch group owners → POST with `scope: { assignmentType: "Owner" }`
    - Fetch PIM eligible → POST with `scope: { assignmentType: "Eligible" }`
- [ ] `Sync-EntraIDGovernance.ps1`
    - Fetch catalogs → POST to `/api/ingest/governance/catalogs`
    - Fetch access packages → POST to `/api/ingest/resources` with `scope: { resourceType: "BusinessRole" }`
    - Fetch AP assignments → POST to `/api/ingest/resource-assignments` with `scope: { assignmentType: "Governed" }`
    - Fetch AP resource scopes → POST to `/api/ingest/resource-relationships` with `scope: { relationshipType: "Contains" }`
    - Fetch AP policies → POST to `/api/ingest/governance/policies`
    - Fetch AP requests → POST to `/api/ingest/governance/requests`
    - Fetch AP reviews → POST to `/api/ingest/governance/certifications`
- [ ] `Sync-EntraIDRelationships.ps1`
    - Discover resource relationships from ingested data (group nesting, app role grants)
    - POST to `/api/ingest/resource-relationships`
- [ ] `Sync-EntraIDContexts.ps1`
    - Calculate department contexts from principals
    - POST to `/api/ingest/contexts`

### Validation (Parity Test)

- [ ] Run old `Start-FGSync` against test tenant → snapshot all table row counts and checksums
- [ ] `Clear-FGDatabase`
- [ ] Run new `Start-EntraIDCrawler` against same tenant
- [ ] Compare row counts and checksums — must match:

```sql
SELECT 'Principals' AS [Table], COUNT(*) AS [Rows]
FROM dbo.Principals WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'Resources', COUNT(*) FROM dbo.Resources WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'ResourceAssignments', COUNT(*) FROM dbo.ResourceAssignments WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'ResourceRelationships', COUNT(*) FROM dbo.ResourceRelationships WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'GovernanceCatalogs', COUNT(*) FROM dbo.GovernanceCatalogs WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'AssignmentPolicies', COUNT(*) FROM dbo.AssignmentPolicies WHERE ValidTo = '9999-12-31 23:59:59.9999999'
UNION ALL SELECT 'Contexts', COUNT(*) FROM dbo.Contexts WHERE ValidTo = '9999-12-31 23:59:59.9999999'
```

- [ ] Verify UI matrix, risk scores, entity detail pages all work with crawler-ingested data
- [ ] Run crawler twice → second run has 0 inserts, updates only for changed records
- [ ] Remove a group from Entra ID, re-run crawler → group deleted from SQL, visible in history

---

## Phase 5: CSV Crawler

**Goal:** A standalone crawler replaces `Start-FGCSVSync` for CSV/Omada data.

### Crawler scripts

Create `Crawlers/CSV/` folder:

- [ ] `Start-CSVCrawler.ps1` — orchestrator:
    1. Load config (API URL, crawler key, CSV folder path, delimiter)
    2. Register/get system via `POST /api/ingest/systems`
    3. Sync in dependency order: OrgUnits → Resources → ResourceDetails → Principals → Identities → ResourceAssignments → Certifications
    4. `POST /api/ingest/refresh-views`
- [ ] `Sync-CSVOrgUnits.ps1` — read `Orgunits.csv`, POST to `/api/ingest/contexts`
- [ ] `Sync-CSVResources.ps1` — read `Permissions.csv` + `Permission-full-details.csv`, POST to `/api/ingest/resources`
- [ ] `Sync-CSVResourceRelationships.ps1` — read `Permission-Nesting.csv`, POST to `/api/ingest/resource-relationships`
- [ ] `Sync-CSVPrincipals.ps1` — read `Users.csv`, POST to `/api/ingest/principals`
- [ ] `Sync-CSVIdentities.ps1` — read `Identities.csv` + `Employment.csv`, POST to `/api/ingest/identities` + `/api/ingest/identity-members`
- [ ] `Sync-CSVResourceAssignments.ps1` — read `Account-Permission.csv`, POST to `/api/ingest/resource-assignments`
- [ ] `Sync-CSVCertifications.ps1` — read `CRAs.csv`, POST to `/api/ingest/governance/certifications`

### Validation (Parity Test)

- [ ] Run old `Start-FGCSVSync` against Omada test dataset → snapshot table counts
- [ ] `Clear-FGDatabase`
- [ ] Run new `Start-CSVCrawler` against same dataset
- [ ] Compare row counts — must match
- [ ] Verify UI shows CSV data alongside any Entra data (if both crawlers run)

---

## Phase 6: Remove Old Sync Path

**Goal:** Clean break — old direct-SQL sync functions are removed entirely.

- [x] Delete `Start-FGSync.ps1` and `Start-FGCSVSync.ps1`
- [x] Delete all 35 `Sync-FG*` functions and migration functions
- [x] Retain `Initialize-FGSyncTable.ps1` and `New-FGDataTableFromGraphObjects.ps1` (used by table initialization)
- [ ] Update `New-FGAzureAutomationAccount` to deploy crawler scripts instead of sync functions
- [ ] Update config template with crawler settings section (API URL, crawler key reference)
- [ ] Update `docs/sync/entra-id.md` and `docs/sync/csv-import.md` to document crawler as the only method
- [ ] Update `README.md` getting started section

### Validation

- [ ] Module loads without errors (`Import-Module .\FortigiGraph.psd1 -Force`)
- [ ] New crawler is the documented default path
- [ ] Azure Automation can deploy and run crawlers

---

## Phase 7: Example Python Crawler (Optional)

**Goal:** Demonstrate that any language can now feed data into FortigiGraph.

- [ ] Create `Crawlers/Examples/python-entra-crawler/`
    - `requirements.txt`: `requests`, `msal`
    - `crawler.py`: minimal Entra ID crawler (~100 lines)
    - `README.md`: setup instructions
- [ ] Crawler authenticates with API key, fetches users from Graph, POSTs to ingest API
- [ ] Demonstrates the value proposition: no PowerShell, no SQL access, just HTTP

---

## Done Criteria

The migration is complete when:

- [ ] All data flows through the Ingest API (no direct SQL writes from crawlers)
- [ ] EntraID and CSV crawlers produce identical results to old sync functions
- [ ] Swagger UI is live and clients can be auto-generated
- [ ] Crawler key rotation works end-to-end
- [ ] Old sync functions are deprecated with clear migration path
- [ ] Documentation is updated
