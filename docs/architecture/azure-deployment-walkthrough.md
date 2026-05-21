# Azure deployment — portal walkthrough

Portal-only, point-and-click walkthrough for deploying Identity Atlas to a fresh Azure subscription. No Azure CLI required.

For the architecture rationale, sizing, and ops notes see [azure-deployment.md](./azure-deployment.md).

---

## What you'll get when this is done

- An App Service for Linux Containers running the Identity Atlas web image, reachable at `https://<prefix>-web.azurewebsites.net`
- A Postgres Flexible Server (private credentials, public endpoint, firewall-restricted to Azure services)
- A Container App worker that polls Microsoft Graph on a schedule
- Key Vault, Storage Account (for `/data/uploads`), Log Analytics
- Entra ID single sign-on enforced on every API endpoint — **no anonymous access**

Total time: **~15 minutes**.

## The 3 steps

1. **Step 1** — Deploy the app stack (Bicep template **main.bicep**). The app comes up in OPEN mode (no auth). Output URL is your confirmed hostname.
2. **Step 2a** — Register an Entra App in your tenant using the confirmed hostname. Manual portal work, no Bicep.
3. **Step 2b** — Layer auth onto the deployment (Bicep template **main-auth.bicep**). Tiny template — 3 fields, touches only the App Service's app settings, restarts in ~1 minute.

Each step is targeted: a different button, a different form, a different blast radius. **Want to change anything about the app stack? Re-run Step 1.** That resets auth back to OFF, then re-run Step 2b to restore.

---

## Prerequisites

| Scope | Role |
|-------|------|
| Subscription | `Owner` (or `Contributor` + the ability to assign Key Vault access policies) |
| Entra directory | `Application Administrator` (or `Cloud Application Administrator` + `Application Developer`) |

Both roles are granted by your tenant admin under **Entra ID → Roles and administrators**.

---

## Step 0 — Pick a name prefix

- 3–15 chars, lowercase letters/digits/hyphens
- Must be globally unique — the resulting `<prefix>-web.azurewebsites.net` hostname can't already exist anywhere in Azure

Examples: `idatlas-acme`, `idatlas-fabrikam`. The public hostname will be `https://<prefix>-web.azurewebsites.net`.

---

## Step 1 — Register required resource providers (~3 min, one-time per subscription)

If the subscription has never used Azure Container Instances, the bootstrap deployment-script in Step 1 hangs for 20 minutes trying to register the provider itself and then fails. Register them up-front:

1. Top search → **Subscriptions** → click your target subscription
2. Left nav → **Resource providers**
3. For each of these, type into the filter, click the row, click **Register** at the top:
   - **`Microsoft.ContainerInstance`** — most important
   - `Microsoft.App` — Container Apps Environment + worker
   - `Microsoft.DBforPostgreSQL`
   - `Microsoft.Web`
   - `Microsoft.KeyVault`
   - `Microsoft.OperationalInsights`
   - `Microsoft.ManagedIdentity`

Each one takes ~30 seconds. You can register all of them in parallel.

---

## Step 2 — Deploy the app stack (~6 min)

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

Click the button (opens in a new tab). Fill in:

| Field | Value |
|---|---|
| Subscription | Target subscription |
| Resource group | Create new — e.g. `<prefix>-rg` |
| Region | **Sweden Central** has been the most reliable in EU; West/North Europe sometimes have capacity issues |
| Name prefix | Your prefix from Step 0 |
| Size profile | `s` (~€79/mo) for normal use, `xs` (~€45/mo) for cheapest demo |
| Image channel | `stable` |
| Existing log analytics workspace id | Leave blank to create a fresh workspace, or paste the FULL ARM resource ID of an existing one |

Click **Review + create** → **Create**.

**What happens:** the bootstrap deployment-script first validates the LAW workspace ID format (and fails fast in <30s if it's wrong — pasting a resource group ID instead of a workspace ID is a known trap, the error tells you so directly). Then everything provisions in parallel: storage, identities, KV, Postgres, App Service, Container Apps, worker.

When the deployment finishes, click the deployment → **Outputs**. Copy:
- `appUrl` — e.g. `https://idatlas-acme-web.azurewebsites.net`
- This is the URL you'll use as the redirect URI in Step 3.

Open the URL — the app loads with a yellow "Authentication is disabled — anyone with the URL can access this application" banner. That's expected. No data has been ingested yet, so the OPEN window is low-risk.

### If Step 2 fails

| Error message | Cause | Fix |
|---|---|---|
| `Action SequencerJob exceeded max allowed time` | `Microsoft.ContainerInstance` provider isn't registered | Do Step 1, then redeploy |
| `existingLogAnalyticsWorkspaceId is not a valid Log Analytics workspace resource ID` | You pasted the resource group's ARM ID, not the workspace's | Get the workspace's ID from its Overview → JSON View; or leave the field blank to create a fresh workspace |
| `Site name 'xxx-web' is not available` | Hostname collision with another Azure tenant | Pick a different `namePrefix` and redeploy |
| `No available instances to satisfy this request` | Regional capacity exhausted | Pick a different region and redeploy to a fresh RG |
| `VaultAlreadyExists` | Key Vault name collision with a soft-deleted vault from a previous attempt in the same RG | Pick a different `namePrefix` (KV name is derived from RG name) |
| `Requested data Disk size … cannot be less than current size` | Postgres storage was previously larger; you can't shrink Postgres storage | Use a larger `sizeProfile`, OR delete the RG and redeploy from scratch |

---

## Step 3 — Register the Entra App (~5 min, manual)

You need an App Registration in your tenant so users can sign in. This is a one-time setup per deployment.

1. Search **Entra ID** in the Azure portal → open the **Microsoft Entra ID** blade
2. Left nav → **App registrations** → **+ New registration**
3. Fill in:
   - **Name**: `Identity Atlas` (or whatever you prefer)
   - **Supported account types**: **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI** dropdown: **Single-page application (SPA)** → paste the `appUrl` from Step 2 (e.g. `https://idatlas-acme-web.azurewebsites.net`)
4. Click **Register**

On the app's **Overview** page, copy:
- **Application (client) ID** — you'll paste this in Step 4
- **Directory (tenant) ID** — you'll paste this in Step 4

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

## Step 4 — Turn auth on (~1 min)

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain-auth.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

Click the button (opens in a new tab). This is a DIFFERENT template — much smaller. It only touches the App Service's app settings.

Fill in:

| Field | Value |
|---|---|
| Subscription | Same as Step 2 |
| Resource group | **The SAME RG you used in Step 2** (`<prefix>-rg`) |
| Name prefix | **Same prefix as Step 2** (used to find the App Service inside the RG) |
| Entra tenant id | Paste from Step 3 |
| Entra client id | Paste from Step 3 |

Click **Review + create** → **Create**. Done in ~60 seconds.

The App Service restarts automatically when the settings change. Once it's back up, the yellow banner is gone and the app redirects you to Entra to sign in.

---

## Step 5 — Sign in and validate

1. Open `https://<prefix>-web.azurewebsites.net` (refresh if you already had it open)
2. You'll be redirected to Entra → sign in with a tenant user
3. **Consent prompt on first sign-in** → click **Accept**
4. You land on the Identity Atlas dashboard

### Quick smoke test

- The yellow "Authentication is disabled" banner is **gone**
- **Admin** sub-tabs visible: Crawlers · Data · Account Correlation · Risk Scoring · LLM Settings · Performance · About
- **Hidden on Azure**: Authentication · Containers

### Common first-sign-in issues

| Symptom | Cause | Fix |
|---|---|---|
| Redirect loop between app and login.microsoftonline.com | SPA redirect URI on the App Reg doesn't exactly match the hostname | Step 3.3 — must be `https://<prefix>-web.azurewebsites.net` (no trailing slash, https not http) |
| `AADSTS500011: The resource principal named api://<guid> was not found in the tenant` | The `access` scope or Application ID URI is missing | Step 3.5-3.7 — Expose an API → set the Application ID URI, then add the `access` scope |
| `AADSTS65001: The user or administrator has not consented` | Tenant requires admin consent for the scope and you signed in as a non-admin | Have a tenant admin sign in first to grant consent, or use **Grant admin consent** on the **API permissions** page of the App Reg |

---

## Changing anything later

| Want to change | Do this |
|---|---|
| Size profile (xs ↔ s ↔ m ↔ l ↔ xl) | Re-run Step 2 with the new profile. Auth goes back to OFF; re-run Step 4 to restore. |
| Image channel (stable ↔ edge) | Re-run Step 2 with the new channel. Auth goes back to OFF; re-run Step 4 to restore. |
| Log Analytics workspace (BYO vs new) | Re-run Step 2 with the changed value. Auth goes back to OFF; re-run Step 4 to restore. |
| Entra tenant or client ID | Re-run Step 4 with the new values. Step 2 stack is untouched. |
| Turn auth OFF (debug or demo) | Re-run Step 2 — that resets `AUTH_ENABLED` to false. |

The rule of thumb: **Step 2 = the app stack. Step 4 = auth.** They don't overlap. Re-running Step 2 always returns the deployment to a clean OPEN-mode state.

---

## Step 6 — Tear down (when you're done testing)

Resource Group → top menu **Delete resource group** → type the name to confirm.

**Caveat**: the Key Vault enters soft-delete with **purge protection** enabled — its name is reserved for 7 days. If you want to redeploy to the same resource-group name within that window, the deploy fails at the key-vault step. Wait 7 days or use a different `namePrefix` for the next test.

---

## Restricting which users can sign in

By default, any user in the tenant can sign in. To restrict to specific roles:

1. **App Registration → App roles → Create app role** — define roles like `IdentityAtlas.Read` and `IdentityAtlas.Admin`
2. **Enterprise applications → your app → Users and groups** — assign users / groups to those roles
3. Azure portal → your Web App → **Environment variables** → set `AUTH_REQUIRED_ROLES` = `IdentityAtlas.Read,IdentityAtlas.Admin` → **Apply** (the app restarts). Only users with at least one of those roles can sign in.

This is advanced enough that it isn't on either deploy form — set it post-deploy from the Web App's Environment variables blade.
