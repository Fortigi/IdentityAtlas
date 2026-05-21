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

Total time: **~15 minutes** end-to-end (two deploy passes + Entra app registration).

## Why two passes?

The app's hostname (`https://<prefix>-web.azurewebsites.net`) must match exactly what's registered as a redirect URI in Entra. But Azure won't tell you whether your chosen `<prefix>` is globally available until you actually try to create the App Service. To avoid wasting work on a name collision:

1. **Pass 1** — leave the Entra tenant + client IDs **blank** and deploy. This claims the name and brings the app up in OPEN mode (yellow banner). Takes ~6 minutes.
2. You register the app in Entra with the now-confirmed URL.
3. **Pass 2** — re-run the same Deploy-to-Azure URL with the same resource group and same prefix, this time with the tenant + client IDs filled in. Auth turns on. Takes ~2 minutes.

There's no separate "enable auth" toggle — filling in the two IDs **is** the signal that you want auth on. Both empty = Pass 1 OPEN mode; both filled = Pass 2 auth ON. Only-one-filled is rejected by the deploy with a clear error.

Between Pass 1 and Pass 2 the app is internet-exposed without authentication — but it has no data in it yet (fresh deploy, no crawlers, empty DB), so the risk is low.

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

The public hostname will be: `https://<prefix>-web.azurewebsites.net`. You won't be able to confirm it's available until Pass 1.

---

## Step 1 — Register required resource providers (~3 min, one-time per subscription)

If your subscription has never used Azure Container Instances before, the bootstrap deployment-script in Pass 1 will hang for 20 minutes trying to register the provider itself and then fail. Register them up-front:

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

Each one takes 30 seconds to flip from `NotRegistered` to `Registered`. You can register all of them in parallel.

Already-registered providers show `Registered` immediately and are a no-op.

---

## Step 2 — Pass 1: claim the name (~6 min)

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

Click the button (opens in a new tab). The portal opens the deploy form pre-loaded with our ARM template.

Fill in:

| Field | Value for Pass 1 |
|---|---|
| Subscription | Target subscription |
| Resource group | Create new — e.g. `<prefix>-rg` |
| Region | **Sweden Central** (West/North Europe have had capacity issues recently — anything else in Europe is fine, but Sweden has been most reliable) |
| Name prefix | Your prefix from Step 0 |
| Size profile | `s` (~€79/mo) for normal use, `xs` (~€45/mo) for cheapest demo |
| Image channel | `stable` |
| Existing log analytics workspace id | (leave blank — creates a new workspace) |
| Entra tenant id | **(leave blank)** |
| Entra client id | **(leave blank)** |

Click **Review + create** → **Create**.

**What happens:** Azure validates the template (takes a few seconds), then provisions all resources. If your prefix is taken, validation rejects within seconds with a clear error — pick a different prefix and try again. No App Reg work wasted because you haven't created one yet.

**If it succeeds:** the **Deployments** view shows each module ticking through (~6 min total). The deployment outputs include `appUrl`: that's your confirmed hostname. Copy it.

Open the URL in a browser. You should see the Identity Atlas dashboard with a yellow "Authentication is disabled" banner at the top. **This is expected** — you haven't turned auth on yet.

### If Pass 1 fails

| Error message | Cause | Fix |
|---|---|---|
| `Action SequencerJob exceeded max allowed time` | `Microsoft.ContainerInstance` provider isn't registered | Do Step 1, then redeploy |
| `entraTenantId and entraClientId must be EITHER both empty OR both filled in` | You filled in exactly one of the two Entra fields | Either fill in the second one (Pass 2) or clear both (Pass 1) |
| `Site name 'xxx-web' is not available` | Hostname collision with another Azure tenant | Pick a different `namePrefix` and redeploy |
| `No available instances to satisfy this request` | Regional capacity exhausted on the App Service or Container Apps scale unit | Pick a different region and redeploy to a fresh RG |
| `VaultAlreadyExists` | Key Vault name collision with a soft-deleted vault from a previous attempt with the same RG name | Pick a different `namePrefix` (KV name is derived from RG name) |

---

## Step 3 — Create the Entra App Registration (~5 min)

Now that you have a confirmed hostname, register the app in Entra so users can sign in.

1. In the Azure portal, search **Entra ID** in the top search bar → open the **Microsoft Entra ID** blade
2. Left nav → **App registrations** → **+ New registration**
3. Fill in:
   - **Name**: `Identity Atlas` (or whatever you prefer)
   - **Supported account types**: **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI** dropdown: **Single-page application (SPA)** → paste the `appUrl` from Pass 1 (e.g. `https://idatlas-acme-web.azurewebsites.net`)
4. Click **Register**

You land on the app's **Overview** page. Two things to copy:

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

Done with the App Registration. You have:
- Tenant ID
- Client ID
- Redirect URI registered + API scope exposed

---

## Step 4 — Pass 2: turn auth on (~2 min)

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

Click the button again (opens in a new tab). Fill in **the exact same values as Pass 1**, with three changes:

| Field | Value for Pass 2 |
|---|---|
| Subscription | Same |
| Resource group | **Same RG you used in Pass 1** (`<prefix>-rg`) |
| Name prefix | **Same prefix** (this is critical — the App Reg redirect URI must match the same hostname) |
| Size profile, image channel | Same as Pass 1 |
| Existing log analytics workspace id | Same as Pass 1 |
| **Entra tenant id** | **Paste from Step 3** |
| **Entra client id** | **Paste from Step 3** |

Click **Review + create** → **Create**.

**What happens:** Azure detects most resources are unchanged. The only differences are the App Service env vars (`AUTH_ENABLED`, `AUTH_TENANT_ID`, `AUTH_CLIENT_ID`) and the bootstrap deployment-script (which re-validates the auth config — now passes because you filled in the IDs). Pass 2 finishes in ~2 minutes.

---

## Step 5 — Sign in and validate

1. Open `https://<prefix>-web.azurewebsites.net` in a fresh browser tab (or hard-refresh if you already had it open from Pass 1)
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
| Redirect loop between app and login.microsoftonline.com | SPA redirect URI on the App Reg doesn't exactly match the hostname | Step 3.3 — must be `https://<prefix>-web.azurewebsites.net` (no trailing slash, https not http) |
| `AADSTS500011: The resource principal named api://<guid> was not found in the tenant` | The `access` scope or Application ID URI is missing | Step 3.5-3.7 — Expose an API → set the Application ID URI, then add the `access` scope |
| `AADSTS65001: The user or administrator has not consented` | Tenant requires admin consent for the scope and you signed in as a non-admin | Have a tenant admin sign in first to grant consent, or use **Grant admin consent** on the **API permissions** page of the App Reg |

---

## Step 6 — Tear down (when you're done testing)

Resource Group → top menu **Delete resource group** → type the name to confirm.

Cleanup takes ~5–10 minutes. **Caveat**: the Key Vault enters soft-delete with **purge protection** enabled — its name is reserved for 7 days. If you want to redeploy to the same resource-group name within that window, the deploy will fail at the key-vault step. Either wait 7 days or use a different `namePrefix` for the next test.

---

## Adding more users

By default, any user in the tenant can sign in. To restrict to specific roles:

1. **App Registration → App roles → Create app role** — define roles like `IdentityAtlas.Read` and `IdentityAtlas.Admin`
2. **Enterprise applications → your app → Users and groups** — assign users / groups to those roles
3. In the Azure portal go to the Web App → **Environment variables** → set `AUTH_REQUIRED_ROLES` = `IdentityAtlas.Read,IdentityAtlas.Admin` → **Apply** (the app restarts). Only users with at least one of those roles can now sign in.

Required-role enforcement is an advanced setting and isn't on the deploy form — set it post-deploy from the Web App's Environment variables blade as above.

---

## Skipping Pass 1 if you already know your name is unique

If you've previously verified availability (e.g. you used the Azure portal's "Create App Service" wizard to type the name and saw the green check, then cancelled), you can collapse the two passes into one:

1. Step 0 — pick name (confirmed available)
2. Step 1 — RP registration
3. Step 3 — create App Reg with `https://<prefix>-web.azurewebsites.net` as the redirect URI
4. One deploy with `enableEntraAuth=true` and the IDs filled in

The two-pass flow above is just the safe default for first-time deployers.
