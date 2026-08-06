# Config File Reference

In the Docker deployment, **most settings are managed through the UI** (Admin → Crawlers wizard). You only need a config file when you want to run a crawler script outside the Docker worker container — for example, when the data source lives on a network the worker can't reach.

The template lives at `setup/config/tenantname.json.template` and is also returned by the script-download feature in the UI.

=== "Linux / macOS"

    ```bash
    cp setup/config/tenantname.json.template ./config.production.json
    ```

=== "Windows (PowerShell)"

    ```powershell
    Copy-Item setup/config/tenantname.json.template ./config.production.json
    ```

!!! warning "Keep config files out of source control"
    Config files contain credentials. The repo `.gitignore` excludes `config*.json`. Never commit these files.

---

## Section: Graph

Microsoft Graph credentials for the Entra ID crawler. Used by `Start-EntraIDCrawler.ps1` when running the script outside Docker.

| Key | Type | Description |
|---|---|---|
| `TenantId` | string | Tenant where the App Registration lives (GUID or `contoso.onmicrosoft.com`). |
| `ClientId` | string | Application (client) ID of the App Registration. |
| `ClientSecret` | string | Client secret value. Required for client-credentials flow. |

The App Registration needs these Graph API application permissions:

| Permission | Purpose |
|---|---|
| `User.Read.All` | Read all users |
| `Group.Read.All` | Read all groups |
| `GroupMember.Read.All` | Read group memberships |
| `Directory.Read.All` | Read directory data |
| `Application.Read.All` | Read service principals and app role assignments |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup` | Read PIM group eligibility |
| `EntitlementManagement.Read.All` | Read catalogs, access packages, assignments, policies, requests |
| `AccessReview.Read.All` | Read access review decisions |
| `AuditLog.Read.All` | Read sign-in and audit events (optional) |

When using the in-browser wizard, these permissions are validated automatically — the wizard shows a green/red checklist of which ones are granted.

---

## Section: LLM

!!! info "Docker deployments: configure AI in the UI"
    In the Docker deployment the AI provider is configured at **Admin → LLM Settings**, not via a config file. The API key is stored encrypted in the built-in secrets vault. The config file approach below is only relevant when running the PowerShell risk-profile scripts outside Docker.

Supported providers: `anthropic`, `openai`, `azure-openai`. Only public organisational context (domain, industry) is sent to the AI — no user names, emails, or identity data. See [Risk Scoring → Data Privacy](../risk-scoring/overview.md#data-privacy) for details.

**Anthropic / OpenAI:**

| Key | Type | Description |
|---|---|---|
| `Provider` | string | `Anthropic` or `OpenAI` |
| `Model` | string | Optional model override. Defaults: Anthropic → `claude-sonnet-4-6`, OpenAI → `gpt-4o`. |
| `ApiKey` | string | API key. Can also be supplied via `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` env vars. |

**Azure OpenAI** (additional keys):

| Key | Type | Description |
|---|---|---|
| `Provider` | string | `azure-openai` |
| `ApiKey` | string | Azure OpenAI resource key. |
| `Endpoint` | string | Resource endpoint, e.g. `https://my-resource.openai.azure.com` |
| `Deployment` | string | Deployment name as configured in Azure. |
| `ApiVersion` | string | Optional. Defaults to `2024-08-01-preview`. |

---

## Section: RiskScoring

| Key | Type | Description |
|---|---|---|
| `Enabled` | bool | Whether risk scoring is active. |
| `CustomerDomain` | string | Tenant domain for risk profile generation. |

Risk scoring can also be toggled at runtime in the UI: **Admin → Risk Scoring** → toggle switch. The toggle persists in the `WorkerConfig` SQL table and overrides the env var / config setting.

---

## Account Linking

Account Linking is configured entirely in the UI — **Admin → Account Linking** — not via a config file. It is deterministic and dictionary-based; **there is no LLM**.

The active configuration lives in the `AccountLinkingConfig` SQL table:

| Field | Description |
|---|---|
| `rules` | The editable dictionary: weighted `signals`, regex `accountTypeRules`, the `linkThreshold` (the certainty slider), and `onlyLinkTypes`. |
| `schedules` | Array of schedules; the server-side scheduler queues a run when one matches the current minute. |
| `isActive` | Whether linking is active. |

Runs can also be triggered on demand from the same Admin page; each run records its progress in `AccountLinkingRuns`. Editing config and starting runs requires the `admin.crawlers` permission. See [Account Linking](../architecture/account-linking.md) for the engine and dictionary.

---

## Where settings actually live

| Setting | Where it lives in Docker deployment |
|---|---|
| Crawler credentials (Tenant ID, Client ID, Secret) | `CrawlerConfigs` SQL table — set via the wizard |
| Object types to sync | `CrawlerConfigs.config.selectedObjects` — set via the wizard |
| Custom user / group attributes | `CrawlerConfigs.config.customUserAttributes` / `customGroupAttributes` — set via the wizard |
| Identity filter | `CrawlerConfigs.config.identityFilter` — set via the wizard |
| Schedules | `CrawlerConfigs.config.schedules` — set via the wizard |
| Risk scoring on/off | `WorkerConfig.FEATURE_RISK_SCORING` — set via the Admin → Risk Scoring toggle |
| Performance monitoring on/off | Runtime flag — set via the Admin → Performance toggle |
| Database connection | Backend env var `DATABASE_URL` (PostgreSQL connection string) |
| Filter/attribute value list size | Backend env var `MATRIX_VALUE_PAGE_SIZE` — how many distinct values a filter dropdown preloads per field (default `500`, max `5000`). Lower it on a test deployment to exercise the "more values than fit in the list" behaviour without importing thousands of objects; see [Matrix → Attribute values](../architecture/matrix.md#attribute-values--paged-discovery-not-a-silent-cap) |
| High-cardinality demo data | Demo Dataset crawler option **"Also load high-cardinality test data"** (`includeVolumeData`) — set via Admin → Crawlers. Loads ~520 extra groups with distinct descriptions so a test environment crosses the value-list threshold above on real data; off by default |

The legacy JSON config file is only needed if you want to run a crawler script (`Start-EntraIDCrawler.ps1`, `Start-CSVCrawler.ps1`) on a machine outside the Docker worker.
