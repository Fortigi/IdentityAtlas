# Setting up authentication (SSO) & roles

By default Identity Atlas runs in **open mode** — no sign-in, and every gate is a
no-op. That is fine for a laptop or an isolated evaluation, but on any shared or
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
   **Application (client) ID** and your **Directory (tenant) ID**.
2. **Expose an API** — accept the default Application ID URI `api://<client-id>`.
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
    On the managed Azure App Service deployment, `AUTH_ENABLED=true` is set from
    first boot and the platform manages sign-in, so the Docker CLI recovery steps
    below don't apply. Roles & Permissions is still managed in the UI.

---

## Step 3 — Sign in

Open the app and sign in with the account you assigned the `Admin` role. After
sign-in the SPA calls `GET /api/auth-me` to learn its own permissions and reveals
the controls you're entitled to — including the **Admin** tab and its sub-tabs.
Hidden controls are also enforced server-side, so this is a UX nicety, not the
security boundary.

---

## Step 4 — Manage roles & permissions in the UI

Once you're in as an admin, edit the live mapping under **Admin → Authentication →
Roles & Permissions**. This maps each Entra ID app role to a set of permissions
from the fixed catalog, so "who can do what" changes without a code change.

The seed mapping a fresh install ships with:

| Role | Permissions |
|---|---|
| `Admin` | `*` (all permissions) |
| `RoleMiner` | `data.read`, `data.export.ui`, `data.export.apikey` |
| `Servicedesk` | `data.read` |

A **self-lockout guard** blocks any save that would strip your own `admin.auth`
permission, so you can't accidentally revoke your own ability to manage roles.

!!! note "Roleless users fail closed"
    A signed-in user whose roles resolve to no permissions is denied every write
    and admin gate. Read endpoints are not permission-gated, so a roleless user
    can still read data — set `AUTH_REQUIRED_ROLES` if you need to stop roleless
    users from signing in at all.

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
