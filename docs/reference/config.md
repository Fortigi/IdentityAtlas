# Config File Reference

In the Docker deployment, **most settings are managed through the UI** (Admin → Crawlers wizard). You only need a config file when you want to run a crawler script outside the Docker worker container — for example, when the data source lives on a network the worker can't reach.

The template lives at `setup/config/tenantname.json.template` and is also returned by the script-download feature in the UI.

```bash
# Copy the template
cp setup/config/tenantname.json.template ./config.production.json

# Edit it with your tenant + Graph credentials
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

Configures the AI provider used by `New-FGRiskProfile`, `New-FGRiskClassifiers`, and `New-FGCorrelationRuleset`. Only anonymized structural data is sent to the LLM — no user names, emails, or identity data.

| Key | Type | Description |
|---|---|---|
| `Provider` | string | `Anthropic` or `OpenAI`. |
| `Model` | string | Optional model override (e.g. `claude-sonnet-4-20250514`, `gpt-4o`). |
| `ApiKey` | string | API key. |

The LLM key can also be supplied via environment variables: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

---

## Section: RiskScoring

| Key | Type | Description |
|---|---|---|
| `Enabled` | bool | Whether risk scoring is active. |
| `CustomerDomain` | string | Tenant domain for risk profile generation. |

Risk scoring can also be toggled at runtime in the UI: **Admin → Risk Scoring** → toggle switch. The toggle persists in the `WorkerConfig` SQL table and overrides the env var / config setting.

---

## Section: AccountCorrelation

| Key | Type | Description |
|---|---|---|
| `Enabled` | bool | Whether account correlation is active. |

The correlation ruleset is generated once with `New-FGCorrelationRuleset` (optionally with an LLM), saved to SQL with `Save-FGCorrelationRuleset`, and then re-applied every time a crawler completes via the post-sync `Invoke-FGAccountCorrelation` step. No file-based scheduling is needed.

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

The legacy JSON config file is only needed if you want to run a crawler script (`Start-EntraIDCrawler.ps1`, `Start-CSVCrawler.ps1`) on a machine outside the Docker worker.
