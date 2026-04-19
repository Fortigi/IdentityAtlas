# Excel Power Query workbook export

Identity Atlas can hand a data analyst a pre-configured Excel workbook that
pulls live data from the API via Power Query. A freshly-minted read-only
token is embedded in the workbook, so refreshing the data on any machine is
a single click — no API credentials to paste, no connections to configure.

## Who this is for

- Data analysts who want Identity Atlas data in Excel or Power BI without
  learning the API
- Anyone building ad-hoc reports (access reviews, risk dashboards, compliance
  reports) against live principal / assignment / resource data
- Teams that want to pipe Identity Atlas into an existing BI stack via the
  API but without standing up interactive OAuth for their service accounts

## What the download contains

One `.xlsx` file with these sheets:

| Sheet                  | Endpoint                            | Contents                                                 |
| ---------------------- | ----------------------------------- | -------------------------------------------------------- |
| README                 | —                                   | Usage notes                                              |
| Settings               | —                                   | `BaseUrl` + `AuthToken` pre-populated named-range cells  |
| Systems                | `GET /api/systems`                  | Connected systems (Entra ID, Omada, CSV-backed, …)       |
| Principals             | `GET /api/users`                    | Every principalType — users, service principals, MIs, AI agents |
| Resources              | `GET /api/resources`                | Groups, directory roles, app roles, business roles       |
| Assignments            | `GET /api/assignments`              | Who has access to what (from `ResourceAssignments`)      |
| Identities             | `GET /api/identities`               | Real-person identities aggregated from multiple accounts |
| IdentityMembers        | `GET /api/identity-members`         | Identity ↔ account links                                 |
| ResourceRelationships  | `GET /api/resource-relationships`   | Parent↔child resource links (Contains, GrantsAccessTo)   |

The Principals and Resources tabs auto-expand the `extendedAttributes` JSONB
column into first-class `ext_*` columns (`ext_userType`,
`ext_onPremisesSyncEnabled`, `ext_signInActivity`, `ext_appId`, etc.). Keys
are collected across every row, so sparsely-populated attributes still show
up.

## How to use it

1. **Admin → Data → Excel Power Query Workbook**.
2. Click **Generate token & download workbook**. A token is created and
   the workbook is streamed back (a few KB).
3. Open the file in Excel.
4. For each data tab (Principals, Resources, Assignments, …):
   - Go to **Data → Get Data → From Other Sources → Blank Query**.
   - In Power Query Editor: **Home → Advanced Editor**.
   - Copy the M code from cell A6 of that sheet and paste it into the
     editor. Click **Done**.
   - Rename the query to match the sheet name (e.g. `Principals`).
   - **Home → Close & Load To… → Existing worksheet → that sheet, cell A1**.
5. Back in Excel, **Data → Refresh All**. Every sheet fills with live data.

> **One-click refresh coming soon.** The current workbook requires the
> paste-into-Advanced-Editor step per sheet. A follow-up PR ships a
> hand-built template where the queries auto-load on first open — at
> that point the flow becomes "download → open → Refresh All".

## Rotating or retiring tokens

Each download mints a **new** read token so you have a fresh credential.
The **Existing tokens** table on the same page lists every outstanding
token with its prefix, creation date, and last-used timestamp. Click
**Revoke** to invalidate any token immediately — workbooks using that
token stop refreshing on their next attempt.

## How the token is used against the API

The workbook's M code reads the token from the `AuthToken` named range
and sends it on every request:

```
Authorization: Bearer fgr_…
```

The token works on **every read endpoint** (`/api/users`,
`/api/resources`, `/api/systems`, `/api/assignments`,
`/api/identity-members`, `/api/resource-relationships`,
`/api/identities`, etc.). It does **not** work on mutating endpoints
(POST/PUT/PATCH/DELETE) nor on any `/api/admin/*` endpoint — the auth
middleware rejects those with HTTP 403.

That scoping means you can hand the token to a BI stack, a script, or a
curl one-liner and the blast radius of a leak is read access only. It is
**not** a substitute for a user's Entra ID sign-in when you need to
manage data.

## Updating a workbook to point at a different deployment

The workbook works against whatever Identity Atlas host generated it.
To retarget an existing workbook (e.g. point a locally-authored workbook
at a production deployment):

1. Open the workbook's **Settings** sheet.
2. Change cell **B2** (`BaseUrl`) to the new `/api` base — e.g.
   `https://identityatlas.example.com/api`.
3. Paste in a new read token you generated on the target deployment in
   cell **B3** (`AuthToken`).
4. **Refresh All**. Every query picks up the new values because they all
   read from the named ranges.

No M code edits needed — you only touch those two cells.

## Building your own reports from this

The workbook's tabs are just starting points. Once the raw data is loaded
as Excel tables, you can:

- Pivot any tab against any other via Power Query's **Merge** feature
  (e.g. Assignments ⨝ Principals on `principalId`)
- Build pivot tables directly on a loaded sheet
- Use the `ext_*` columns as pivot filters for fine-grained slicing
  (e.g. "Service Principals with `ext_servicePrincipalType = ManagedIdentity`")
- Chain into Power BI — same M code, same token pattern, same endpoints

## Security notes

- **Tokens are secrets.** The `Settings` sheet is not encrypted. If you
  share the workbook, anyone with the file can read from the API as
  long as the token is active. Rotate the token after sharing.
- **Tokens are read-only.** They cannot mutate data or reach admin
  endpoints — but they CAN list every principal, resource, and
  assignment. Treat that with the same discretion as a database dump.
- **Revoke proactively.** When someone leaves the team, or when a
  workbook is superseded, revoke the token from Admin → Data. The
  token's `lastUsedAt` timestamp helps you tell active from stale.
- **Per-user tokens.** Click **Create token only…** to mint named
  tokens that don't get bundled into a workbook, useful for scripts or
  BI connectors. The Admin → Data list shows which person/integration
  owns each one.

## Related

- [Authoring the polished XLSX template](./excel-template-authoring.md) —
  for the maintainer wiring up the one-click-refresh template
- [API reference](../api/index.md) — the endpoints your Power Query
  code hits
