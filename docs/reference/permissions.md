# Permissions & Role Mapping

Identity Atlas authorizes every API request against a **fixed catalog of permissions**. Customers map their Entra ID **app roles** to those permissions, so "who can do what" is configurable without code changes.

This page is the reference for the permission model. The catalog below is kept in sync with the code by a test (`app/api/src/auth/docsCoverage.test.js`) — if a permission is added to the catalog without being documented here, CI fails.

## How authorization works

1. **Authentication** — when `AUTH_ENABLED=true`, every `/api/*` request must carry a valid Entra ID bearer token (or a read/crawler API key). When `AUTH_ENABLED=false` (the default for local/laptop use) the API runs in **open mode**: all gates are no-ops and a banner warns that anyone with the URL has full access. Open mode is a supported deployment for evaluation and single-user local runs — **do not** use it on a network without a trusted boundary.
2. **Role → permission resolution** — the token's `roles` claim is resolved to a set of permissions via the configured mapping (Admin → Authentication → Roles & Permissions), falling back to the built-in seed mapping.
3. **Per-route enforcement** — each protected route declares the permission(s) it needs via `requirePermission(...)`. The gate is attached to the **individual route**, not the `/api` mount, so one router's permission never affects another's endpoints.
4. **Wildcard** — a role mapped to `*` is granted every permission (including ones added in future releases). The seed `Admin` role uses `*`.

!!! note "Read & crawler API keys"
    - **Read API keys (`fgr_…`)** are accepted only on `GET` requests to non-admin endpoints and resolve to `data.read`. They're used by the generated Excel/Power Query workbook.
    - **Crawler API keys (`fgc_…`)** authenticate the worker on `/api/crawlers/*` and `/api/ingest/*` only, with their own per-crawler scope (`systemIds`) and permissions (`ingest`, `refreshViews`, `admin`). They are separate from the user-facing permission catalog below.

## Permission catalog

Permissions are grouped into **Read**, **Export**, **Write**, and **Admin**.

### Read

| Permission | Label | Notes |
|---|---|---|
| `data.read` | Read all data | Effectively "can sign in at all." Enforced as authentication-required — any signed-in user can read; there is no per-route `requirePermission('data.read')` gate. `fgr_` read tokens are granted it implicitly. |

### Export

| Permission | Label | Gated endpoint (representative) |
|---|---|---|
| `data.export.ui` | Export to Excel/CSV | `GET /api/admin/export/curated`, `POST /api/admin/data-export/workbook` |
| `data.export.apikey` | Generate read-only API keys | `POST /api/admin/read-tokens` (mint your own `fgr_` token) |

### Write

| Permission | Label | Gated endpoint (representative) |
|---|---|---|
| `data.write.tags` | Manage tags | `POST/PATCH/DELETE /api/tags…` |
| `data.write.categories` | Manage categories | `POST/PATCH/DELETE /api/categories…` |
| `data.write.risk` | Risk score overrides | `PUT/DELETE /api/risk-scores/:type/:id/override` |
| `data.write.certifications` | Certification decisions | **Reserved** — no interactive endpoint yet. Certification decisions are currently ingested via the crawler (`POST /api/ingest/governance/certifications`). When an approve/revoke endpoint is added it will be gated by this permission. |

### Admin

| Permission | Label | Gated endpoint (representative) |
|---|---|---|
| `admin.crawlers` | Crawler configuration | `GET/POST/PATCH/DELETE /api/admin/crawlers…`, crawler jobs, trigger risk-scoring runs |
| `admin.systems` | Systems configuration | `PUT /api/systems/:id`, owners, clean-database, history-retention |
| `admin.llm` | LLM configuration | `/api/admin/llm/*`, risk profiles/classifiers, correlation rulesets |
| `admin.context-plugins` | Context plugins | `/api/context-plugins…` (run/configure clustering, manager-hierarchy, etc.) |
| `admin.csv-import` | CSV import | `/api/admin/crawler-configs/:id/csv-files`, custom-connector ingest |
| `admin.read-tokens` | Manage read API keys | `GET/DELETE /api/admin/read-tokens` (list/revoke tokens minted by others) |
| `admin.feature-flags` | Feature flags | `POST /api/admin/features/toggle` |
| `admin.auth` | Authentication & roles | `GET/PUT/DELETE /api/admin/roles` — edits this very mapping. A self-lockout guard prevents a save that would strip your own `admin.auth`. |

## Seed (default) role mapping

A fresh install ships with this mapping (customisable in the Admin UI):

| Role | Permissions |
|---|---|
| `Admin` | `*` (all permissions) |
| `RoleMiner` | `data.read`, `data.export.ui`, `data.export.apikey` |
| `Servicedesk` | `data.read` |

A signed-in user whose roles resolve to **no** permissions currently falls back to the `*` wildcard (a backward-compatibility behaviour for installs that haven't assigned app roles yet). Set `AUTH_REQUIRED_ROLES` to require an explicit role for any access.

## UI gating

The SPA calls `GET /api/auth-me` after sign-in to learn its own permissions and hides controls the user can't use (the **Admin** tab, its sub-tabs, and export buttons). The server remains the source of truth — hidden controls are also enforced server-side, so hiding is a UX nicety, not a security boundary.

## Deployment notes

- **Open mode (`AUTH_ENABLED=false`)** — supported for local/evaluation use; all permission gates are bypassed.
- **Azure App Service** — `AUTH_ENABLED=true` is set from first boot; the Authentication and Containers admin sub-tabs are hidden (managed platform).
- Tenant/client IDs are configured via `AUTH_TENANT_ID` / `AUTH_CLIENT_ID`; the role→permission mapping is edited live in Admin → Authentication.

## Testing

Enforcement is verified by:

- **`app/api/src/auth/permissionMatrix.test.js`** — for every gated permission, asserts the representative endpoint is reachable **with** the permission and returns `403` **without** it; plus a completeness guard that fails if any catalog permission is unclassified.
- **`app/api/src/middleware/requirePermission.test.js`** — unit tests for the gate decision logic.
- **`app/ui/e2e/permission-gating.spec.js`** — confirms the UI shows/hides the Admin tab and sub-tabs per permission.
- **`app/api/src/auth/docsCoverage.test.js`** — fails if a catalog permission is missing from this page.
