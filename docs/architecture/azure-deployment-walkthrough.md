# Azure deployment — portal walkthrough

A customer-facing, point-and-click walkthrough for deploying Identity Atlas to a fresh Azure subscription. Targets users who don't have the Azure CLI installed and want to do everything from the portal.

For the architecture rationale, sizing, and ops notes see [azure-deployment.md](./azure-deployment.md).

---

## What you'll get when this is done

- An App Service for Linux Containers running the Identity Atlas web image, reachable at `https://<prefix>-web.azurewebsites.net`
- A Postgres Flexible Server (private credentials, public endpoint, firewall-restricted to Azure services)
- A Container App worker that polls Microsoft Graph on a schedule
- Key Vault, Storage Account (for `/data/uploads`), Log Analytics
- Entra ID single sign-on enforced on every API endpoint — **no anonymous access**

Total deploy time: **~6–7 minutes**.

## Prerequisites

**Permissions you need in the target tenant + subscription:**

| Scope | Role |
|-------|------|
| Subscription | `Owner` (or `Contributor` + the ability to assign Key Vault access policies) |
| Entra directory | `Application Administrator` (or `Cloud Application Administrator` + `Application Developer`) |

Both roles are granted by your tenant admin under **Entra ID → Roles and administrators**.

---

## Step 0 — Pick a name prefix

This goes into every resource name and the public hostname, so decide first.

- 3–15 characters
- Lowercase letters, digits, hyphens
- Must be globally unique — the resulting `<prefix>-web.azurewebsites.net` hostname can't already exist anywhere in Azure

Examples: `idatlas-acme`, `idatlas-fabrikam`, `id-atlas-prod`.

The public hostname will be: `https://<prefix>-web.azurewebsites.net` — write this down, you need it in Step 1.

---

## Step 1 — Create the Entra App Registration (~5 min)

The Identity Atlas web client uses Entra ID for sign-in via MSAL.js (Single-Page Application flow). You need to register the app in your tenant before deploying.

1. In the Azure portal, search **Entra ID** in the top search bar → open the **Microsoft Entra ID** blade
2. Left nav → **App registrations** → **+ New registration**
3. Fill in:
   - **Name**: `Identity Atlas` (or whatever you prefer — only visible to tenant admins)
   - **Supported account types**: **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI** dropdown: **Single-page application (SPA)** → enter `https://<prefix>-web.azurewebsites.net` (use the prefix from Step 0)
4. Click **Register**

You land on the app's **Overview** page. Two things to copy down:

- **Application (client) ID** — copy
- **Directory (tenant) ID** — copy

### Expose the API scope

The MSAL client requests a custom scope `api://<client-id>/access`. Tell Entra about it:

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

Done with the App Registration. Hold onto the client ID and tenant ID — you'll paste them into the deploy form in Step 3.

---

## Step 2 — Register required resource providers (~3 min, one-time per subscription)

If your subscription has never used Azure Container Instances before, the bootstrap deployment-script will hang for 20 minutes trying to register the provider itself and then fail. Register them up-front:

1. Top search → **Subscriptions** → click your target subscription
2. Left nav → **Resource providers**
3. For each of these, type the name into the filter, click the row, click **Register** at the top:
   - **`Microsoft.ContainerInstance`** — most important; runs the deployment script
   - `Microsoft.App` — Container Apps Environment + worker
   - `Microsoft.DBforPostgreSQL` — Postgres
   - `Microsoft.Web` — App Service
   - `Microsoft.KeyVault`
   - `Microsoft.OperationalInsights` — Log Analytics
   - `Microsoft.ManagedIdentity`

Each one takes 30 seconds to flip from `NotRegistered` to `Registered`. You can register all of them in parallel — kick off the next one while the previous is still registering.

Already-registered providers show `Registered` immediately and are a no-op.

---

## Step 3 — Deploy

Click the Deploy to Azure button in the README. The portal opens the deploy form pre-loaded with our ARM template.

Fill in:

| Field | Value |
|---|---|
| Subscription | Target subscription |
| Resource group | Create new — `<prefix>-rg` |
| Region | **Sweden Central** (West/North Europe have had capacity issues recently — anything else in Europe is fine, but Sweden has been most reliable) |
| Name prefix | Your prefix from Step 0 |
| Size profile | `s` for normal use (~€79/mo), `xs` for cheapest demo (~€45/mo). See [sizing](./azure-deployment.md#sizing) |
| Image channel | `stable` — the last cut release. Use `edge` only if you specifically want main-branch builds |
| Web image override | (leave blank) |
| Worker image override | (leave blank) |
| Enable Entra auth | **✓ Enabled** (default — the deploy fails fast if you turn this off without meaning to) |
| Entra tenant id | Paste from Step 1 |
| Entra client id | Paste from Step 1 |
| Entra required roles | (leave blank — any signed-in user in the tenant can sign in) |
| Existing log analytics workspace id | (leave blank — creates a new workspace; or paste an existing workspace's full resource ID to forward logs there) |
| Web allowed IP CIDRs | (leave empty — relies on Entra for access control. Add CIDRs if you want a hard IP allowlist on top.) |

Click **Review + create** → **Create**.

In the **Deployments** view you'll see the modules tick through:

```
log-analytics      ✓  (~30s)
identities         ✓  (~15s)
storage            ✓  (~20s)
key-vault          ✓  (~40s)
bootstrap          ✓  (~30s — validates auth config, generates master key into KV)
postgres           ✓  (~2 min)
app-service        ✓  (~1 min)
aca-env            ✓  (~1 min)
aca-app-worker     ✓  (~30s)
```

Total ~6–7 minutes.

### If the deploy fails

| Error message | Cause | Fix |
|---|---|---|
| `Action SequencerJob exceeded max allowed time` | `Microsoft.ContainerInstance` provider isn't registered | Do Step 2, then redeploy |
| `enableEntraAuth=true but entraTenantId and/or entraClientId are empty` | You left one or both of the Entra fields blank | Fill them in (recommended), or set `enableEntraAuth=false` to deploy in OPEN mode for a quick demo |
| `No available instances to satisfy this request` | Regional capacity exhausted on the App Service or Container Apps scale unit | Pick a different region and redeploy to a fresh RG |
| `VaultAlreadyExists` | Key Vault name collision with a soft-deleted vault | Pick a different `namePrefix` (KV name is derived from the RG name) |

---

## Step 4 — First sign-in and validation

1. Open `https://<prefix>-web.azurewebsites.net` in a fresh browser tab
2. You'll be redirected to Entra → sign in with a tenant user
3. **Consent prompt appears on first sign-in** → click **Accept**
4. You land on the Identity Atlas dashboard

### Quick smoke test

- The yellow "Authentication is disabled" banner should be **gone**
- Click **Admin** in the top nav and check the sub-tabs:
  - ✅ Visible: Crawlers · Data · Account Correlation · Risk Scoring · LLM Settings · Performance · About
  - ❌ Hidden on Azure: Authentication · Containers
- Click **About** → confirm the version and license info loads

### Common first-sign-in issues

| Symptom | Cause | Fix |
|---|---|---|
| Redirect loop between app and login.microsoftonline.com | SPA redirect URI on the App Reg doesn't exactly match the hostname | Step 1.3 — must be `https://<prefix>-web.azurewebsites.net` (no trailing slash, https not http) |
| `AADSTS500011: The resource principal named api://<guid> was not found in the tenant` | The `access` scope or Application ID URI is missing | Step 1.5-1.7 — Expose an API → set the Application ID URI, then add the `access` scope |
| `AADSTS65001: The user or administrator has not consented` | Tenant requires admin consent for the scope and you signed in as a non-admin | Have a tenant admin sign in first to grant consent, or use **Grant admin consent** on the **API permissions** page of the App Reg |

---

## Step 5 — Tear down (when you're done testing)

Resource Group → top menu **Delete resource group** → type the name to confirm.

Cleanup takes ~5–10 minutes. **Caveat**: the Key Vault enters soft-delete with **purge protection** enabled — its name is reserved for 7 days. If you want to redeploy to the same resource-group name within that window, the deploy will fail at the key-vault step. Either wait 7 days or use a different `namePrefix` for the next test.

---

## Adding more users

By default, any user in the tenant can sign in. To restrict to specific groups:

1. **App Registration → App roles → Create app role** — define roles like `IdentityAtlas.Read` and `IdentityAtlas.Admin`
2. **Enterprise applications → your app → Users and groups** — assign users / groups to those roles
3. Redeploy with `entraRequiredRoles=IdentityAtlas.Read,IdentityAtlas.Admin` set on the Bicep parameter — only users with at least one of those roles can sign in
