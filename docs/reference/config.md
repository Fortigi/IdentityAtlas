# Configuration

Most of Identity Atlas is configured in the UI: crawlers and their credentials, schedules, the LLM provider, feature switches, roles and account linking. Those settings are stored in the database. This page lists what is configured **outside** the UI, through environment variables on the containers, and where the UI settings are stored.

The compose files set the variables a normal Docker deployment needs; you rarely set more than `POSTGRES_PASSWORD`. The variables you put in the `.env` file next to the compose file are explained on the [Docker Setup](../architecture/docker-setup.md#environment-variables) page. The Azure templates set their own values; see [Azure Deployment Reference](../architecture/azure-deployment.md).

Unless noted otherwise, a variable is read by the **web** container (the API).

## Database

| Variable | Default | Meaning |
|---|---|---|
| `USE_SQL` | not set | Must be `true`. Every compose file and the Azure template set it. Without it the API runs without a database and most endpoints answer with empty data. |
| `DATABASE_URL` | not set | A full PostgreSQL connection string. When set, the `POSTGRES_*` variables below are ignored. |
| `POSTGRES_HOST` | `postgres` | Database host |
| `POSTGRES_PORT` | `5432` | Database port |
| `POSTGRES_DB` | `identity_atlas` | Database name |
| `POSTGRES_USER` | `identity_atlas` | Database user |
| `POSTGRES_PASSWORD` | empty | Database password. `docker-compose.prod.yml` refuses to start without it and hands it to the containers as a secret file. |
| `PGSSLMODE` | not set | Standard PostgreSQL client setting. The Azure template sets `require`. |
| `PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `600000` (10 minutes) | A database session that sits idle inside a transaction this long is closed. `0` turns this off. |

### Secrets from files

`DATABASE_URL`, `POSTGRES_PASSWORD` and `IDENTITY_ATLAS_MASTER_KEY` can also be given as a file: set `<NAME>_FILE` to the path, for example `POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password`. The file is read once at start. When both are set, the plain variable wins. The production compose file uses this for the database password.

## Authentication

Sign-in is set up with the `auth-config` command described in [Authentication & SSO](../admin/authentication.md). That command stores its values in the database, and **stored values win over these variables**. The variables only count when nothing is stored.

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_ENABLED` | `false` | `true` turns on Entra ID sign-in. The Azure template sets `true`. |
| `AUTH_TENANT_ID` | empty | Entra ID tenant ID. Tokens from other tenants are refused. |
| `AUTH_CLIENT_ID` | empty | Client ID of the app registration. The API accepts access tokens for `api://<client id>`. |
| `AUTH_REQUIRED_ROLES` | not set | Comma-separated Entra app roles, for example `Admin,RoleMiner`. A user who has none of them is refused everything. The roles that ship with a permission mapping are `Admin`, `RoleMiner` and `Servicedesk`; see [Permissions & Roles](permissions.md). |

With `AUTH_ENABLED=true` but no tenant or client ID, the UI shows a setup page instead of a sign-in.

## Security and reverse proxy

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | not set | Comma-separated origins allowed to call the API from a browser on another origin. `*` is ignored. Without it, a production container allows no other origins. The host names in these origins also count as allowed hosts. |
| `ALLOWED_HOSTS` | not set | Comma-separated host names users type to reach Identity Atlas, for example `atlas.example.com`. Only enforced while authentication is off: a request for a dotted host name that is not allowed is answered `421`. Always allowed: `localhost`, IP addresses, single-label names (`web`), `.local` names, the host of `PUBLIC_BASE_URL`, the hosts in `ALLOWED_ORIGINS` and `WEBSITE_HOSTNAME`. `/api/health` and the crawler endpoints are never blocked. |
| `PUBLIC_BASE_URL` | not set | The public URL of the deployment, for example `https://atlas.example.com`. The Excel workbook export embeds it, and its host is an allowed host. Recommended behind any proxy, tunnel or Azure. |
| `BEHIND_TLS` | `false` | Set `true` when a TLS terminator sits in front. Turns on HSTS and `upgrade-insecure-requests`, makes the workbook export use `https://`, and trusts one proxy hop. The Azure template sets `true`. |
| `TRUST_PROXY_HOPS` | `1` with `BEHIND_TLS` or `TRUST_PROXY`, else `0` | How many proxies in front may set `X-Forwarded-For`. The client address it yields is used for rate limits and audit rows. Use `2` for Front Door in front of App Service; `0` turns it off. |
| `TRUST_PROXY` | `false` | `true` when a trusted proxy overwrites `X-Forwarded-Host` and `X-Forwarded-Proto`; the workbook export then uses them. Prefer `PUBLIC_BASE_URL`. |
| `WEBSITE_HOSTNAME`, `WEBSITE_SITE_NAME`, `WEBSITE_RESOURCE_GROUP` | set by Azure | Azure App Service sets these. The API uses them to recognise Azure, to allow its own host name, and to show Azure-specific setup instructions. |

## Secrets vault

The vault holds crawler credentials, the LLM API key and scraper credentials, encrypted with a master key. [Secrets and the Master Key](../architecture/secrets-and-master-key.md) explains it, including backup and rotation.

| Variable | Default | Meaning |
|---|---|---|
| `IDENTITY_ATLAS_MASTER_KEY` | not set | The master key: 32 random bytes, base64-encoded (`openssl rand -base64 32`). When set, it is used instead of a key file. The Azure template reads it from Key Vault. |
| `IDENTITY_ATLAS_KEY_DIR` | not set | Folder for the generated key file `.master-key`. The compose files set `/data/keys`, a volume only the web container mounts. |
| `MASTER_KEY_FILE` | not set | An explicit path for the key file. Wins over `IDENTITY_ATLAS_KEY_DIR`. Without either, the key file is `/data/uploads/.master-key`. |
| `IDENTITY_ATLAS_ALLOW_NEW_MASTER_KEY` | `false` | The API refuses to generate a new key while the vault holds secrets, because a new key cannot read them. `true` allows it, and the stored secrets are lost. |
| `IDENTITY_ATLAS_MASTER_KEY_PREVIOUS` | not set | Read only by the key-rotation command: the key the vault is encrypted with today. |

## Server and updates

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | Port the API listens on inside the container |
| `HOST` | `0.0.0.0` | Address the API listens on. The portable app always uses `127.0.0.1`. |
| `NODE_ENV` | `production` in the images | In production, cross-origin calls are refused unless `ALLOWED_ORIGINS` is set, and a warning is logged when authentication is off. |
| `PERF_METRICS_ENABLED` | on | Request timing for the Performance page. `false` turns it off at start; the page can switch it at run time. |
| `IMAGE_TAG` | `latest` | The release channel this deployment follows (`latest`, `beta`, `edge` or a pinned version). The compose file uses it to pick the image; the update check uses it to know what "newer" means. |
| `MODULE_VERSION` | set in the image | The version the API reports |
| `COMPOSE_FILE_VERSION` | set by the compose file | Lets the Dashboard warn when the compose file is older than the image expects. Do not change it by hand. |
| `GITHUB_TOKEN` | not set | Optional token for the update check's calls to GitHub. It lifts GitHub's rate limit for anonymous calls. |
| `DESKTOP_MODE` | not set | Set by the portable Windows app. Do not set it in Docker. |

## Files and paths

These have working defaults in the images. Change them only when you mount volumes elsewhere.

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `UPLOAD_ROOT` | `/data/uploads` | web | Where crawler and context uploads are stored |
| `TRACE_DIR` | `/data/uploads/jobs` | web, worker | Crawler job logs |
| `WORKER_KEY_FILE` | `/data/uploads/.builtin-worker-key` | web, worker | The built-in worker's crawler API key. The web container writes it; the worker reads it. |
| `CRAWLER_MANIFESTS_DIR` | `$IA_APP_ROOT/crawlers` | web | Where the crawler definitions are read from |
| `IA_APP_ROOT` | `/app` (worker) | web, worker | Root of the bundled crawler scripts |
| `FRONTEND_DIST` | the built UI inside the image | web | Folder the UI is served from |

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `UPLOAD_MAX_FILE_BYTES` | `8589934592` (8 GiB) | Largest crawler file upload |
| `UPLOAD_MIN_FREE_BYTES` | `1073741824` (1 GiB) | Free space that must remain on the upload volume after an upload; otherwise the upload is refused with `507` |
| `UPLOAD_CONFIG_QUOTA_BYTES` | `0` (no quota) | Storage quota per crawler configuration's upload folder; over it, uploads are refused with `413` |
| `CRAWLER_AUDIT_LOG_MAX_ROWS` | `10000` | Crawler audit-log rows kept per crawler; the maintenance job trims older rows. `0` keeps everything. |
| `MATRIX_VALUE_PAGE_SIZE` | `500` (at most `5000`) | How many distinct values a filter dropdown loads per field. More values stay reachable through the dropdown's search box. See [Reading the Matrix](../architecture/matrix.md#attribute-values-paged-discovery-not-a-silent-cap). |
| `MATRIX_REFRESH_DEBOUNCE_MS` | `3000` | How long the matrix refresh waits after a crawler's last write before it runs |
| `MATRIX_REFRESH_MIN_INTERVAL_MS` | `5000` | Minimum time between two matrix refreshes |

The request-size and rate limits that are not configurable are listed in the [API overview](../api/index.md#limits).

## Feature switches

Each optional feature has a switch in **Admin**. The switch is stored in the database and wins over the variable; the variable only sets the starting value of a deployment.

| Variable | Default | Feature |
|---|---|---|
| `FEATURE_RISK_SCORING` | off | Risk scoring |
| `FEATURE_ACCOUNT_LINKING` | on | Account linking. `FEATURE_ACCOUNT_CORRELATION` is read as an older name. Only `false` turns it off. |
| `FEATURE_EXPERIMENTAL_CRAWLERS` | off | Experimental crawlers |
| `FEATURE_MATRIX_SHARING` | off | Sharing a matrix with colleagues |
| `FEATURE_CUSTOM_REPORTS` | off | Custom reports and the report generator. The Azure template sets it on. |
| `FEATURE_CONTEXT_ASSISTANT` | off | Building a context by describing it |
| `FEATURE_MCP_SERVER` | off | The MCP server for AI assistants. Works only with authentication on. |
| `FEATURE_ORG_KNOWLEDGE` | off | Organisation knowledge (interviews and claims) |
| `FEATURE_SOURCE_OWNER_ACCOUNTABLES` | on | The owner a source names for a synced context becomes its Accountable. Only `false` turns it off. |
| `FEATURE_SOURCE_OWNER_NAME_MATCH` | off | Also match those owners by display name |

A switch that is off by default takes `true` to turn on. [Experimental Features](experimental-features.md) describes what each switch does.

## LLM and report generator

### Risk profiles (cloud LLM)

The provider, model, endpoint and API key are set in **Admin → LLM Settings**; the key is stored in the vault. Supported providers are `anthropic`, `openai` and `azure-openai`. When no model is chosen, Anthropic uses `claude-sonnet-4-6` and OpenAI uses `gpt-4o`; Azure OpenAI always needs the deployment name.

| Variable | Default | Meaning |
|---|---|---|
| `LLM_TIMEOUT_MS` | `120000` | Time limit for one call to the provider |

### Report generator (local model)

The report generator is a separate container with a small local model, used by custom reports, the context assistant, context uploads and interviews. See [Report Generator](report-generator.md).

| Variable | Default | Meaning |
|---|---|---|
| `NL_REPORTS_LLM_URL` | not set | Address of the model server. The production compose file sets `http://report-generator:8080`. Interviews, context-upload refinement and the warm-up only use the model when this is set. |
| `NL_REPORTS_LLM_BACKEND` | `llamacpp` | `ollama` switches to an Ollama server |
| `NL_REPORTS_LLM_API_KEY` | empty | Key the model server requires. The Azure template sets it from Key Vault. |
| `NL_REPORTS_LLM_TIMEOUT_MS` | `900000` (15 minutes) | Time limit for one model answer |
| `INTERVIEW_LLM_TIMEOUT_MS` | `NL_REPORTS_LLM_TIMEOUT_MS` | Time limit for one answer while reading an interview |
| `NL_REPORTS_DEFAULT_MODEL` | `qwen2.5-coder:7b` | Ollama only: the model to use |
| `NL_REPORTS_KEEP_ALIVE` | `10m` | Ollama only: how long the model stays loaded |

The **report-generator** container itself is configured through these compose variables:

| Compose variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | not set | `report-generator` starts the container |
| `REPORT_GENERATOR_CPUS` | `2` | CPUs (and threads) the model may use |
| `REPORT_GENERATOR_MEMORY` | `4g` | Memory limit |
| `REPORT_GENERATOR_IDLE_SECONDS` | `900` | Seconds unused before the model is unloaded; `0` keeps it loaded |

## Crawler worker

Read by the **worker** container.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_API_URL` | `http://web:3001/api` | Where the worker reaches the API |
| `CRAWLER_API_KEY` | empty | A fixed crawler API key. Leave it empty: the worker then reads the key the web container writes to `WORKER_KEY_FILE`. |
| `WORKER_KEY_FILE`, `TRACE_DIR`, `IA_APP_ROOT` | see [Files and paths](#files-and-paths) | |
| `IDENTITY_ATLAS_CRAWLER_IDENTITY_CLIENT_ID` | not set | Client ID of the managed identity the Entra ID crawler signs in with, for a crawler set to use a managed identity. The Azure template sets it. See [Entra ID](../sync/entra-id.md#signing-in-without-a-secret-managed-identity). |

The worker never receives the database password or the vault master key. Crawler credentials reach it per job.

## Where the UI settings are stored

| Setting | Set in | Stored in |
|---|---|---|
| Crawler credentials, selected objects, custom attributes, identity filter, schedules | Admin → Crawlers | `CrawlerConfigs` (credentials encrypted in the vault) |
| Feature switches | Admin → Experimental, Admin → Risk Scoring | `WorkerConfig`, keys `FEATURE_*` |
| LLM provider and model | Admin → LLM Settings | `WorkerConfig`, key `LLM_CONFIG`; the API key in the vault |
| Sign-in settings | The `auth-config` command | `WorkerConfig`, keys `AUTH_*` |
| Role-to-permission mapping | Admin → Roles & Permissions | `WorkerConfig`, key `AUTH_ROLE_PERMISSIONS` |
| Account linking | Admin → Account Linking | `AccountLinkingConfig` |

### Account linking

Account linking is deterministic and dictionary-based; it uses no LLM. The active configuration lives in the `AccountLinkingConfig` table:

| Field | Description |
|---|---|
| `rules` | The editable dictionary: weighted `signals`, regex `accountTypeRules`, the `linkThreshold` (the certainty slider), `onlyLinkTypes`, and `allowNameOnlyLinks`. |
| `schedules` | Array of schedules; the server-side scheduler queues a run when one matches the current minute. |
| `isActive` | Whether linking is active. |

Keys inside `rules`:

| Key | Default | Description |
|---|---|---|
| `signals` | 9 shipped signals | Weighted match rules. An account links to the candidate identity with the highest summed weight that clears `linkThreshold`. Name signals never sum with each other — only the strongest reading of the name fires — but the three `evidence` signals (`nameUnique`, `department`, `manager`) do add to it: each says something singled **one** person out of the people the name allows. Weight 0 switches a signal off, which also releases the links it had already made on the next run. |
| `accountTypeRules` | 4 shipped rules | Regex patterns classifying an account as Admin / Guest / Service / Shared. |
| `linkThreshold` | `50` | Minimum confidence to auto-link — the certainty slider in the UI. It is the one control for how much evidence a link needs: at `60` a unique surname-and-initial match stops linking, at `75` a unique full-name one does. |
| `onlyLinkTypes` | `["Admin", "Guest", "Secondary"]` | Only these account types are ever attached to a person. |
| `allowNameOnlyLinks` | `true` | A match whose signals are all name signals links where that name identifies exactly one person, or where the account's own department or manager singles exactly one of its claimants out. A second person answering to the same name — spelled the same, stating the same initials, or, where nobody is spelled it exactly, sharing its surname and first initial — makes the match ambiguous: it is counted and held for review instead, and any such link made earlier is removed on the next run. Set to `false` — unchecking **"Link on a name match alone"** in Admin → Account Linking — to hold back *every* name-only match, which stops a display-name-only source linking at all. Only a literal `false` opts out; a config that never stored the key runs the shipped policy. |

Runs can also be started from the same Admin page. Each run records its progress in `AccountLinkingRuns`, including how many name-only matches it held for review and why (`nameOnlyMatches`, `nameOnlySuggestions`), how many name-only links it removed because the policy would no longer create them (`linksRemoved`), and how many it created on a name shared only at the weaker surname-and-initial level (`linksRestored`). Editing the configuration and starting runs requires the `admin.crawlers` permission. See [One Person, Many Accounts](../architecture/account-linking.md) for the engine and the dictionary.

## Running a crawler script outside Docker

A crawler script can run on another machine, for example when the source sits on a network the worker cannot reach. It takes the API address, a crawler API key and a JSON file with that crawler's configuration (`-ConfigPath`). The API and the worker read no configuration file of their own. The Graph API permissions the Entra ID crawler needs are listed in [Entra ID → Required Graph API Permissions](../sync/entra-id.md#required-graph-api-permissions).
