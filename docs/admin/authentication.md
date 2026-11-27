# Setting up authentication (SSO) & roles

By default the Docker stack runs in **open mode** — no sign-in, and every gate is a
no-op (the Azure deployment is the exception: it requires sign-in from the first
deploy, see the note in step 2). That is fine for a laptop or an isolated evaluation, but on any shared or
networked deployment you want Entra ID single sign-on and role-based access. This
guide walks through turning that on end to end, and — crucially — getting your
first admin in without locking yourself out.

For the underlying permission model (the full catalog, seed mapping, and how gates
resolve), see [Permissions & Role Mapping](../reference/permissions.md). This page
is the task flow; that page is the reference.

!!! warning "Assign yourself a role *before* you enable auth"
    The order matters. Because there is deliberately no "no roles → full admin"
    fallback, enabling auth before you have an admin role locks everyone out of
    the admin UI. Do step 1 before step 2.

---

## Step 1 — Register the app and assign yourself the Admin role

Authentication is Entra ID OIDC against an App Registration. In the Entra ID
portal:

1. **Register an application** (or reuse your existing one) and note its
   **Application (client) ID** and your **Directory (tenant) ID**. Under
   **Authentication**, add a **Single-page application (SPA)** redirect URI that
   is exactly the address you open Identity Atlas on, without a trailing slash
   (for example `https://atlas.example.com`). Without it, sign-in fails.
2. **Expose an API** — accept the default Application ID URI `api://<client-id>`
   and add a scope named `access` (the app requests `api://<client-id>/access`).
   Identity Atlas only accepts access tokens whose audience is `api://<client-id>`;
   ID tokens are rejected, which is why this step is required.
3. **Define app roles** on the registration — at minimum an `Admin` role.
4. **Assign your own user** to the `Admin` app role (Enterprise applications →
   your app → Users and groups).

The built-in **seed mapping** maps the `Admin` role to `*` (all permissions), so
assigning yourself `Admin` is enough to get in the first time. You can customise
the role → permission mapping later (step 4).

---

## Step 2 — Enable authentication

Auth is controlled by environment variables the API reads at startup. Set all
three so the SPA has both the tenant and client IDs it needs:

```bash
AUTH_ENABLED=true
AUTH_TENANT_ID=<your-tenant-guid>
AUTH_CLIENT_ID=<your-client-guid>
```

`AUTH_ENABLED=true` on its own is not enough — with the tenant/client IDs still
empty, the API treats the deployment as "auth enabled but not configured" and
renders a setup-required page until you provide them. Set them in your `.env` (or
inline) and recreate the `web` container.

!!! note "Azure App Service"
    On the Azure App Service deployment, `AUTH_ENABLED=true` is set from the
    first deploy, so you do step 1 after deploying: the app shows a setup page
    until the tenant and client IDs are filled in as environment variables on
    the Web App (see the [Azure walkthrough](../architecture/azure-deployment-walkthrough.md)).
    Sign-in is still enforced by Identity Atlas itself, not by App Service
    Authentication (Easy Auth). The Docker CLI recovery steps below don't apply:
    if you can sign in but see the "You don't have access to Identity Atlas
    yet" page, assign yourself the `Admin` app role in Entra ID and sign in
    again. Roles & Permissions is still managed in
    the UI.

---

## Step 3 — Sign in

Open the app and sign in with the account you assigned the `Admin` role. After
sign-in the SPA calls `GET /api/auth-me` to learn its own permissions and reveals
the controls you're entitled to — including the **Admin** tab and its sub-tabs.
Hidden controls are also enforced server-side, so this is a UX nicety, not the
security boundary.

---

## Step 4 — Manage roles & permissions in the UI

Once you're in as an admin, edit the live mapping under **Admin → Roles &
Permissions** (its own tab, next to Authentication). This maps each Entra ID app role to a set of permissions
from the fixed catalog, so "who can do what" changes without a code change.

The seed mapping a fresh install ships with:

| Role | Permissions |
|---|---|
| `Admin` | `*` (all permissions) |
| `RoleMiner` | `data.read`, `data.export.ui`, `data.export.apikey` |
| `Servicedesk` | `data.read` |

A **self-lockout guard** blocks any save that would strip your own `admin.auth`
permission, so you can't accidentally revoke your own ability to manage roles.

!!! note "No role, no access"
    A signed-in user whose roles resolve to no permissions gets nothing: every
    endpoint answers 403, and the app shows a page that tells them to ask for a
    role. The only exception is a context owner, below. This does not depend on
    the Entra app requiring assignment or on `AUTH_REQUIRED_ROLES`: anyone in
    the tenant may be able to sign in, and still sees no data without a role.
    To let people read, assign them a role, for example **Servicedesk**.

### Relative permissions: letting owners in

The same **Admin → Roles & Permissions** tab has a second section below the
role table, **Relative permissions**: the access people get because they are
**Accountable** or **Responsible** for something, rather than a role in that
table. It is always read-only and limited to what they answer for.

It is one grid. Each kind of thing people answer for has a row for
Accountable and one for Responsible:

| Row | Sign in & view | Sub-units | MCP | Composition review |
|---|---|---|---|---|
| Organisation | ✓ | ✓ | ✓ | – |
| Applications | ✓ | ✓ | ✓ | – |
| Role portfolios | ✓ | ✓ | ✓ | – |
| Business roles | ✓ | – | – | ✓ |

- **Sign in & view** — they can sign in without an Identity Atlas role and land
  on their own page, read-only: the units, applications, portfolios and
  business roles that row admits, with a unit's report download, a team or
  application matrix, the pages of the people in it and of what they hold, and
  for each member the *names* of what that member holds and which other units
  it is in. Every other screen and endpoint stays closed to them, even if you
  have set `AUTH_REQUIRED_ROLES`.
- **Sub-units** — also every sub-unit below it, at any depth (also those with
  an owner of their own; that owner sees only their own part). Without it they
  see only the unit itself.
- **MCP** — they may also ask about the same things from an AI assistant
  through the [MCP server](../reference/mcp-server.md#context-owners).
- **Composition review** — they may do a
  [composition review](../concepts/governance-model.md#reviewing-what-a-business-role-contains)
  of a business role they answer for, without the Certification decisions
  permission. This one does not need **Sign in & view**: it also applies to
  people who sign in with an ordinary role.

So you can, for example, let only the Accountable of an organisation unit in,
with its sub-units, while a Responsible sees nothing; or let application
owners in without MCP. **Sub-units** and **MCP** can only be ticked where
**Sign in & view** is on in that row. MCP and Composition review also need
their feature switched on under **Admin → Experimental**. People who hold a
role are not affected. Everything is off by default and a change takes effect
without a restart.

Upgrading keeps what you had: until the grid is first saved it shows what the
earlier on/off switches gave — Accountable and Responsible alike, every row.

Matrix-share recipients are **not** a relative permission: someone a matrix is
shared with needs a role, such as Servicedesk, to open it (see
[Sharing a matrix](../ui/sharing-a-matrix.md)).
  That is decided per share; there is no setting for it in this section.

See [Context-owner access](../architecture/context-owner-access.md) for exactly
what a context owner can see and how it is enforced.

---

## Recovering from a lockout

If you enabled auth before assigning yourself a role, no one can reach the admin
UI. Recover from the host shell with the auth CLI: disable auth, fix the role
assignment in Entra ID, then re-enable.

```bash
# 1. Disable auth (recovery path), then restart:
docker compose exec web node src/cli/auth-config.js disable
docker compose restart web

# 2. Assign your user the Admin app role in Entra ID.

# 3. Re-enable auth and restart:
docker compose exec web node src/cli/auth-config.js enable --tenant <tenant-guid> --client <client-guid>
docker compose restart web
```

With auth disabled the app is back in open mode, so do this only from a trusted
host and re-enable as soon as the role assignment is fixed.

---

## Related

- [Permissions & Role Mapping](../reference/permissions.md) — the full permission
  catalog, API-key behavior, and enforcement/testing details.
- [Admin → Data](data-tab.md) — the export/import and database-maintenance tab,
  also permission-gated.
