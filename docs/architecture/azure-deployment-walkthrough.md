# Azure deployment — portal walkthrough

Portal-only, point-and-click walkthrough for deploying Identity Atlas to a fresh Azure subscription. No Azure CLI required.

For the architecture rationale, sizing, and ops notes see [azure-deployment.md](./azure-deployment.md).

---

## What you'll get

- An App Service for Linux Containers running the Identity Atlas web image
- A Postgres Flexible Server (private credentials, public endpoint, firewall-restricted to Azure services)
- A Container App worker that polls Microsoft Graph on a schedule
- Key Vault, Storage Account (for `/data/uploads`), Log Analytics
- Entra ID single sign-on enforced on every API endpoint — **no anonymous access**

Total time: **~15 minutes**.

## The three steps

| | What | Where | Time |
|---|---|---|---|
| **Step 1** | Deploy the app stack | Bicep template `main.json` | ~6 min |
| **Step 2** | Register the Entra App (the deployed app's own UI walks you through it) | Azure portal — Entra ID | ~5 min |
| **Step 3** | Fill in tenant + client IDs as env vars on the Web App | Azure portal — Environment variables | ~1 min |

**Auth is on from the first deploy.** The Bicep ships `AUTH_ENABLED=true` with empty `AUTH_TENANT_ID` / `AUTH_CLIENT_ID`. After Step 1, opening the app's URL shows a **"Set up Entra ID"** page with the exact steps (Steps 2 and 3 of this walkthrough) — there's no usable open-mode state where someone could accidentally use the deployment without auth.

---

## Prerequisites

**Permissions you need in the target tenant + subscription:**

| Scope | Role |
|-------|------|
| Subscription | `Owner` (or `Contributor` + the ability to assign Key Vault access policies) |
| Entra directory | `Application Administrator` (or `Cloud Application Administrator` + `Application Developer`) |

Both roles are granted by your tenant admin under **Entra ID → Roles and administrators**.

**Resource providers** (one-time per subscription): if the subscription has never used Azure Container Instances, the bootstrap deployment-script in Step 1 hangs for 20 minutes trying to register the provider itself and then fails. Register them up-front:

1. Top search → **Subscriptions** → click your target subscription
2. Left nav → **Resource providers**
3. For each of these, type into the filter, click the row, click **Register** at the top:
   - **`Microsoft.ContainerInstance`** — most important
   - `Microsoft.App`
   - `Microsoft.DBforPostgreSQL`
   - `Microsoft.Web`
   - `Microsoft.KeyVault`
   - `Microsoft.OperationalInsights`
   - `Microsoft.ManagedIdentity`

Each one takes ~30 seconds. You can register them all in parallel.

---

## Step 1 — Deploy the app stack (~6 min)

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

Click the button (opens in a new tab). Fill in:

| Field | Value |
|---|---|
| Subscription | Target subscription |
| Resource group | Create new — name it whatever you want (e.g. `idatlas-rg`) |
| Region | **Sweden Central** has been the most reliable in EU; West/North Europe sometimes have capacity issues |
| Size profile | `s` (~€79/mo) for normal use, `xs` (~€45/mo) for cheapest demo |
| Image channel | `stable` |
| Existing log analytics workspace id | Leave blank to create a fresh workspace, or paste the FULL ARM resource ID of an existing one |

Click **Review + create** → **Create**.

**What happens:** the bootstrap deployment-script first validates the LAW workspace ID format (and fails fast in <30s if it's wrong — pasting a resource group ID instead of a workspace ID is a known trap, the error tells you so directly). Then everything provisions in parallel: storage, identities, KV, Postgres, App Service, Container Apps, worker.

When the deployment finishes, click the deployment → **Outputs**. Copy:
- `appUrl` — e.g. `https://idatlas-abc1234-web.azurewebsites.net` — this is the URL you'll use as the redirect URI in Step 2.

Open the URL — you'll see the **"Entra ID setup required"** page. That's the expected state after Step 1: the app is deployed with auth turned on, but no Entra App is wired up yet. The page contains exactly the instructions you need for Steps 2 and 3 below — you can follow them on screen or use the more detailed version here.

### If Step 1 fails

| Error message | Cause | Fix |
|---|---|---|
| `Action SequencerJob exceeded max allowed time` | `Microsoft.ContainerInstance` provider isn't registered | Do the RP registration in Prerequisites, then redeploy |
| `existingLogAnalyticsWorkspaceId is not a valid Log Analytics workspace resource ID` | You pasted the resource group's ARM ID, not the workspace's | Get the workspace's ID from its Overview → JSON View; or leave the field blank to create a fresh workspace |
| `Site name 'xxx-web' is not available` | Hostname collision (extremely rare with the auto-generated prefix) | Pick a different resource group name — the prefix is derived from the RG ID, so changing the RG changes the prefix |
| `No available instances to satisfy this request` | Regional capacity exhausted | Pick a different region and redeploy to a fresh RG |
| `VaultAlreadyExists` | Key Vault name collision with a soft-deleted vault from a previous attempt in a same-named RG | Use a different resource group name (Key Vault soft-delete reserves names for 7 days) |
| `Requested data Disk size … cannot be less than current size` | Postgres storage was previously larger; you can't shrink Postgres storage | Use a larger `sizeProfile`, OR delete the RG and redeploy from scratch |

---

## Step 2 — Register the Entra App (~5 min, portal)

You need an App Registration in your tenant so users can sign in. One-time setup per deployment.

1. Search **Entra ID** in the Azure portal → open the **Microsoft Entra ID** blade
2. Left nav → **App registrations** → **+ New registration**
3. Fill in:
   - **Name**: `Identity Atlas` (or whatever you prefer)
   - **Supported account types**: **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI** dropdown: **Single-page application (SPA)** → paste the `appUrl` from Step 1 (e.g. `https://idatlas-abc1234-web.azurewebsites.net`)
4. Click **Register**

On the app's **Overview** page, copy:
- **Application (client) ID**
- **Directory (tenant) ID**

> **Note:** an SPA application uses the PKCE flow — there is no client secret. Tenant ID and client ID are all you need.

### Expose the API scope

The MSAL client requests a scope `api://<client-id>/access`. Tell Entra about it:

5. Left nav → **Expose an API**
6. Click **Add** next to **Application ID URI** at the top → accept the default value (`api://<client-id>`) → **Save**
7. Click **+ Add a scope**:
   - **Scope name**: `access`
   - **Who can consent**: **Admins and users**
   - **Admin consent display name**: `Access Identity Atlas`
   - **Admin consent description**: `Allow the application to access Identity Atlas on behalf of the signed-in user.`
   - **User consent display name**: `Access Identity Atlas`
   - **User consent description**: `Allow the application to access Identity Atlas on your behalf.`
   - **State**: **Enabled**
   - **Add scope**

---

## Step 3 — Fill in the tenant + client IDs (~1 min, portal)

The Bicep deploy in Step 1 already created `AUTH_TENANT_ID` and `AUTH_CLIENT_ID` env vars on the Web App — they're just empty. You fill them in now.

1. Azure portal → **Resource groups** → your RG → click the **App Service** (named `idatlas-<hash>-web`)
2. Left nav → **Settings** → **Environment variables**
3. Find the existing `AUTH_TENANT_ID` row → click it → paste the **Directory (tenant) ID** from Step 2 → **Apply**
4. Same for `AUTH_CLIENT_ID` → paste the **Application (client) ID** from Step 2 → **Apply**
5. Click **Apply** at the bottom of the page to commit both changes → confirm **Apply changes**

The Web App restarts automatically (~30 seconds). Refresh the app URL — you'll be redirected to Entra to sign in.

---

## Validation

1. Open `https://<your-app-url>` (refresh if you already had it open from Step 1)
2. You'll be redirected to Entra → sign in with a tenant user
3. **Consent prompt on first sign-in** → click **Accept**
4. You land on the Identity Atlas dashboard

### Quick smoke test

- No yellow "Authentication is disabled" banner (it only shows if you explicitly set `AUTH_ENABLED=false`)
- **Admin** sub-tabs visible: Crawlers · Data · Account Correlation · Risk Scoring · LLM Settings · Performance · About
- **Hidden on Azure**: Authentication

### Common first-sign-in issues

| Symptom | Cause | Fix |
|---|---|---|
| Redirect loop between app and login.microsoftonline.com | SPA redirect URI on the App Reg doesn't exactly match the hostname | Step 2.3 — must be `https://<auto-generated-name>-web.azurewebsites.net` (no trailing slash, https not http) |
| `AADSTS500011: The resource principal named api://<guid> was not found in the tenant` | The `access` scope or Application ID URI is missing | Step 2.5-2.7 — Expose an API → set the Application ID URI, then add the `access` scope |
| `AADSTS65001: The user or administrator has not consented` | Tenant requires admin consent for the scope and you signed in as a non-admin | Have a tenant admin sign in first to grant consent, or use **Grant admin consent** on the **API permissions** page of the App Reg |

---

## Changing something later

| Want to change | Do this |
|---|---|
| Size profile (xs ↔ s ↔ m ↔ l ↔ xl) | Re-run Step 1 with the new profile. ⚠ This resets `AUTH_TENANT_ID` and `AUTH_CLIENT_ID` to empty (Bicep's `appSettings` is a full replace) — you'll see the setup-required page again and have to redo Step 3. The IDs themselves don't change, so it's a 30-second paste. |
| Image channel (stable ↔ edge) | Re-run Step 1 with the new channel. Same Step-3-rerun caveat. |
| Log Analytics workspace (BYO vs new) | Re-run Step 1 with the changed value. Same Step-3-rerun caveat. |
| Entra tenant or client ID | Web App → Environment variables → edit `AUTH_TENANT_ID` / `AUTH_CLIENT_ID` → Apply. No redeploy needed. |
| Turn auth OFF (debug or demo) | Web App → Environment variables → set `AUTH_ENABLED=false` → Apply. The app comes back up in OPEN mode with the "Authentication is disabled" banner. Set it back to `true` (and ensure the IDs are still there) to re-enable. |

---

## Tearing down

Resource Group → top menu **Delete resource group** → type the name to confirm.

**Caveat**: the Key Vault enters soft-delete with **purge protection** enabled — its name is reserved for 7 days. If you want to redeploy to a same-named RG within that window, the deploy fails at the key-vault step. Wait 7 days or use a different RG name.

---

## Restricting which users can sign in

By default, any user in the tenant can sign in. To restrict to specific roles:

1. **App Registration → App roles → Create app role** — define roles like `IdentityAtlas.Read` and `IdentityAtlas.Admin`
2. **Enterprise applications → your app → Users and groups** — assign users / groups to those roles
3. Azure portal → your Web App → **Environment variables** → set `AUTH_REQUIRED_ROLES` = `IdentityAtlas.Read,IdentityAtlas.Admin` → **Apply** (the app restarts). Only users with at least one of those roles can sign in.

This is advanced enough that it isn't on either deploy form — set it post-deploy from the Web App's Environment variables blade.
