# Docker Setup

The reference for running Identity Atlas on Docker: what the stack consists of, every setting you can change, how much hardware it needs, and how to put it behind HTTPS or on your own PostgreSQL server.

New here? [Get it running](../quickstart.md) walks through the first start. For keeping a deployment healthy, see [Back up, restore and upgrade](../admin/backup-restore-upgrade.md).

---

## Install

The whole installation is one compose file and a `.env` file with a database password. These are the same commands as on [Get it running](../quickstart.md), which also explains what to check afterwards.

=== "Linux / macOS"

    ```bash
    # 1. Download the compose file
    curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml

    # 2. Create .env with a generated database password (skipped when .env already exists)
    [ -f .env ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env

    # 3. Start everything
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

=== "Windows (PowerShell)"

    ```powershell
    # 1. Download the compose file
    Invoke-WebRequest `
        -Uri https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml `
        -OutFile docker-compose.prod.yml

    # 2. Create .env with a generated database password (skipped when .env already exists)
    if (-not (Test-Path .env)) {
        $bytes = [byte[]]::new(24)
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        "POSTGRES_PASSWORD=$(-join ($bytes | ForEach-Object { $_.ToString('x2') }))" | Set-Content .env -Encoding ascii
    }

    # 3. Start everything
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

Then open `http://localhost:3001`.

The stack starts without sign-in (`AUTH_ENABLED=false`): anyone who can reach port 3001 has full access. That suits an evaluation on your own machine. Before you share it, [set up authentication](../admin/authentication.md) and read [Behind a reverse proxy](#behind-a-reverse-proxy-https).

---

## What runs

```mermaid
graph TB
    subgraph Docker["docker-compose.prod.yml"]
        PG[(postgres<br/>PostgreSQL 16)]
        API[web<br/>API + UI, port 3001]
        WORKER[worker<br/>PowerShell 7 crawlers]
    end

    API -->|migrations, reads, writes| PG
    WORKER -->|claims jobs, posts data| API
    User[Browser] -->|http://localhost:3001| API
```

| Service | Image | Published port | What it does |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `127.0.0.1:5432` | The database. Only reachable from the host itself; the web container reaches it over the internal network. |
| `web` | `ghcr.io/fortigi/identity-atlas` | `3001` | The API and the UI. Applies database migrations when it starts and decides when scheduled crawlers run. |
| `worker` | `ghcr.io/fortigi/identity-atlas-worker` | none | Runs the crawlers. It has no database access: it picks up jobs from the web container and posts what it reads back to it. |

A fourth service, `report-generator`, only starts when you enable its profile. See [Report Generator](../reference/report-generator.md).

### Volumes

| Volume | Mounted in | Holds |
|---|---|---|
| `postgres_data` | `postgres` | The database. |
| `job_data` | `web`, `worker` (`/data/uploads`) | Files uploaded for file-based crawlers, job logs, and the key the worker signs in to the API with. |
| `web_keys` | `web` only (`/data/keys`) | The vault master key, when the web container generated it. |
| `report_generator_slots` | `report-generator` | A cache. It is rebuilt when lost. |

What to back up, and how, is on [Back up, restore and upgrade](../admin/backup-restore-upgrade.md).

### First start

On its first start the web container opens port 3001 right away and then, in the background:

1. applies the database migrations, which create every table, view and index;
2. creates the **Built-in Worker** crawler with a generated API key;
3. writes that key to `/data/uploads/.builtin-worker-key` in the `job_data` volume, where the worker reads it. The key is never served over HTTP.

Until step 1 is done the API answers `503` with `Schema migration in progress, please retry shortly`. `GET /api/health` reports this as `"schemaReady": false`.

### How jobs run

Starting a crawler, loading the demo data or importing a file creates a job. The worker asks the web container for the next queued job every 30 seconds and runs each job in its own `pwsh` process, so no credential, token or tenant ID from one job is still in memory when the next one starts.

Schedules are evaluated by the web container once a minute, in UTC. A crawler runs one job at a time. If a schedule comes due while a job of the same crawler is still queued or running:

- an **Every few minutes** schedule skips that run and waits for its next one;
- any other schedule waits and starts as soon as the running job finishes, for up to an hour.

When a full run and a delta run come due in the same minute, the full run goes first.

What a crawler reads and how to schedule it is described per source, starting with [Entra ID](../sync/entra-id.md).

---

## Environment Variables

`docker-compose.prod.yml` reads its settings from a `.env` file in the same directory. Only `POSTGRES_PASSWORD` is required. A commented template is at [`setup/config/.env.example`](https://github.com/Fortigi/IdentityAtlas/blob/main/setup/config/.env.example).

After changing `.env`, run the `up -d` command again; Compose recreates the containers whose settings changed.

### Database

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | *(none, required)* | The database password. The compose file refuses to start while it is unset or empty. The database keeps the password it was first created with, so a different value later locks the web container out of its own database. Do not change it without also changing it in PostgreSQL. |
| `POSTGRES_USER` | `identity_atlas` | Database user. |
| `POSTGRES_DB` | `identity_atlas` | Database name. |
| `POSTGRES_BIND_HOST` | `127.0.0.1` | Host interface the database port is published on. Set `0.0.0.0` only if you need access from another machine, and firewall it. |
| `POSTGRES_PORT` | `5432` | Host port the database is published on. |

### Web

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Host port the UI and API are published on. |
| `IMAGE_TAG` | `latest` | Which build to run. See [Image channels](#image-channels). |
| `AUTH_ENABLED` | `false` | `true` requires Entra ID sign-in. Needs the two variables below. See [Setting up authentication](../admin/authentication.md). |
| `AUTH_TENANT_ID` | *(empty)* | Your Entra ID tenant ID. |
| `AUTH_CLIENT_ID` | *(empty)* | Client ID of the App Registration people sign in to. |
| `MATRIX_VALUE_PAGE_SIZE` | `500` | How many distinct values a filter dropdown preloads per field (at most 5000). The rest stay reachable through the dropdown's search box. |

### Vault master key

Crawler and LLM credentials are entered in the UI and stored encrypted in the database. The master key is what decrypts them.

| Variable | Default | Description |
|---|---|---|
| `IDENTITY_ATLAS_MASTER_KEY` | *(auto-generated)* | 32 random bytes, base64-encoded (`openssl rand -base64 32`). When empty, the web container generates a key on first start and stores it in the `web_keys` volume. For a deployment you intend to keep, set it **before the first start** so you hold the key yourself. A different key cannot decrypt what is already stored; to change it later, follow [Master key rotation](llm-and-risk-scoring.md#master-key-rotation). |

### Worker

| Variable | Default | Description |
|---|---|---|
| `CRAWLER_API_KEY` | *(auto-generated)* | The API key the worker uses. Leave it empty: the worker reads the generated key from the `job_data` volume. |

### Limits

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_MEM_LIMIT`, `WEB_MEM_LIMIT`, `WORKER_MEM_LIMIT` | `8g` each | Container memory limits. Raise them for large tenants, see [Sizing](#sizing). |

### Settings the compose file does not pass on

The web container understands more settings than `docker-compose.prod.yml` passes to it. Putting these in `.env` has no effect; add them to the `web` service's `environment:` through a second compose file, as shown under [Behind a reverse proxy](#behind-a-reverse-proxy-https).

| Variable | Description |
|---|---|
| `PUBLIC_BASE_URL` | The address people open Identity Atlas on, for example `https://atlas.example.com`. Used for links the app hands out, such as the address inside an exported Excel workbook, and its host name is accepted as an allowed host. |
| `ALLOWED_HOSTS` | Comma-separated extra host names the app answers to. See [Allowed host names](#allowed-host-names). |
| `BEHIND_TLS` | `true` when a TLS-terminating proxy is in front. Turns on HSTS and tells browsers to upgrade requests to HTTPS. Never set it on a deployment that is opened over plain HTTP. |
| `TRUST_PROXY_HOPS` | Number of reverse proxies in front of the app. Makes rate limits and the audit trail see the real client address. `BEHIND_TLS=true` on its own counts as one. |
| `UPLOAD_MAX_FILE_BYTES` | Largest file a file-based crawler upload may contain. Default 8 GiB. |
| `UPLOAD_CONFIG_QUOTA_BYTES` | Total upload space per crawler configuration. Default `0`: no quota. |
| `DATABASE_URL`, `POSTGRES_HOST`, `PGSSLMODE` | See [External PostgreSQL](#external-postgresql). |

`POSTGRES_PASSWORD`, `DATABASE_URL` and `IDENTITY_ATLAS_MASTER_KEY` can each be given as a file instead: set `<NAME>_FILE` to the path of a file that holds the value. A plain variable that is set wins over the file.

---

## Image channels

`IMAGE_TAG` selects the build for the `web` and `worker` images. Both are always published under the same tag.

| `IMAGE_TAG` | What you get | For |
|---|---|---|
| *(empty)* or `latest` | The last stable release. | Production. |
| `beta` | The latest pre-release. | Trying a release before it is final. |
| `edge` | The latest build of the main branch. May contain unfinished work. | Testing what is coming. |
| An exact version, such as `5.2.1.0` | That release and nothing else. | Production where you decide when to upgrade. |

When you pin an older release, use the `docker-compose.prod.yml` from that release as well. Switching channels and pinning are covered in [Back up, restore and upgrade](../admin/backup-restore-upgrade.md#upgrade).

---

## Sizing

Identity Atlas runs all three services (postgres, web, worker) on one host. These numbers are the floor: RAM first, disk second. The RAM figure is what the crawler's peak workload needs; tight provisioning makes the host thrash when a sync runs, not at idle. The disk figure is for the `postgres_data` volume plus the image layers.

| Tenant shape | Accounts | Activity sync | RAM | Disk |
|---|---|---|---|---|
| Small | < 2k | off | **4 GB** | 20 GB |
| Small + activity | < 2k | on (7 days) | **6 GB** | 40 GB |
| Medium | 2k – 10k | off | **6 GB** | 40 GB |
| Medium + activity | 2k – 10k | on (7 days) | **12 GB** | 60 GB |
| Large | 10k – 50k | mixed | **16+ GB** | 100+ GB |
| Enterprise | 50k+ | on | **24+ GB** | 250+ GB |

Each container is also capped at 8 GB by default. On a host sized for the last two rows, raise `POSTGRES_MEM_LIMIT`, `WEB_MEM_LIMIT` and `WORKER_MEM_LIMIT`.

For measured ingest times on a 2-million-record dataset, see [Scaling & Load Testing](scaling.md).

### Why activity data dominates

"Activity sync" means the Entra ID crawler's **Sign-in Logs** option. Account and resource tables stay roughly proportional to your organisation: a tenant with 10k users has about 10k rows in `Principals`. Activity is one-to-many over time: the same tenant emits around 170,000 sign-in events per week.

Three things control the activity footprint:

- **The number of days of sign-in logs**, set in the Entra ID crawler wizard (`signInLogsDays`). Linear in RAM and disk. The default is 7 days. Microsoft Graph retains 30, so at the extreme you multiply the numbers above by about 4.
- **What is kept.** Only the latest event per account and application is stored, so the table does not grow without bound. Each crawl still holds the raw slice in memory before it is reduced.
- **The number of connected systems.** Each additional system adds its own accounts, resources and activity. Plan about 50% headroom for a second system.

### What to watch as usage grows

```bash
# Host memory pressure during a crawl
free -h && swapon --show

# Database size by table (top 10)
docker compose -f docker-compose.prod.yml exec postgres psql -U identity_atlas -d identity_atlas -c \
  "SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
     FROM pg_catalog.pg_statio_user_tables
    ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;"

# Crawler duration trend
docker compose -f docker-compose.prod.yml exec postgres psql -U identity_atlas -d identity_atlas -c \
  "SELECT \"jobType\", \"startedAt\", \"completedAt\" - \"startedAt\" AS duration
     FROM \"CrawlerJobs\" WHERE status='completed'
    ORDER BY \"startedAt\" DESC LIMIT 20;"
```

Warning signs: any swap in use, `PrincipalActivity` above 40% of the database size (read fewer days of sign-in logs or add memory), and a crawler run that takes longer than the interval it is scheduled on.

### Swap

Do not rely on swap to carry crawler peaks. Node, PowerShell and PostgreSQL all slow down sharply when they page. If the table says 12 GB, give the host 12 GB of real RAM. A small swap partition (1–2 GB) as a safety net against out-of-memory kills is fine.

---

## Container Security

`docker-compose.prod.yml` applies these defaults:

- **The database password is a secret file, not an environment variable.** Compose reads `POSTGRES_PASSWORD` from `.env` and hands it to the `postgres` and `web` containers as a file under `/run/secrets`, so it does not show up in `docker inspect`. This needs a recent Docker Compose v2 (v2.20 or later is recommended).
- **The vault master key is out of the worker's reach.** An auto-generated key lives in the `web_keys` volume, which the worker does not mount.
- **The worker holds few secrets.** It receives neither the database password nor the master key. Crawler and LLM credentials reach it per job.
- **The database is not on the network.** Its port is published on `127.0.0.1` only.
- **Hardening.** Every service runs with `no-new-privileges` and all Linux capabilities dropped (PostgreSQL keeps the five its entrypoint needs), with a process limit and a memory limit. The web and worker images run as an unprivileged user.
- **Supply chain.** Base images are pinned by digest, and every published image carries signed build provenance and an SBOM: `gh attestation verify oci://ghcr.io/fortigi/identity-atlas:latest --owner Fortigi`.

---

## Behind a reverse proxy (HTTPS)

Identity Atlas listens on port 3001 over plain HTTP and does not terminate TLS itself. For anything other than a local evaluation, put a reverse proxy with a certificate in front of it and tell the app about it.

**1. Tell the app.** Create a second compose file next to the first one, for example `docker-compose.local.yml`:

```yaml
services:
  web:
    environment:
      PUBLIC_BASE_URL: "https://atlas.example.com"
      BEHIND_TLS: "true"
      TRUST_PROXY_HOPS: "1"
```

and name both files in every compose command from now on:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml up -d
```

Set `TRUST_PROXY_HOPS` to the number of proxies between the browser and the app (2 when a load balancer sits in front of your proxy). Without it, every request appears to come from the proxy's address, so all users share one rate limit.

**2. Configure the proxy.** A minimal nginx server block:

```nginx
server {
    listen 443 ssl;
    server_name atlas.example.com;

    ssl_certificate     /etc/ssl/certs/atlas.example.com.pem;
    ssl_certificate_key /etc/ssl/private/atlas.example.com.key;

    # File uploads for file-based crawlers can be large. Identity Atlas
    # enforces its own limit, so do not cap or buffer them here.
    client_max_body_size 0;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The `Host` header must reach the app unchanged, and `X-Forwarded-For` must be set by the proxy, not passed through from the client.

**3. Close the direct route.** Port 3001 is published on every interface of the host. Firewall it so that only the proxy can reach it.

**4. Update the sign-in address.** With authentication on, the App Registration needs a **Single-page application** redirect URI that is exactly the HTTPS address, without a trailing slash (`https://atlas.example.com`). See [Setting up authentication](../admin/authentication.md).

!!! note "Not tested end to end"
    The settings above are taken from the application's source and the compose file. The nginx block uses standard directives only and was not run against a live deployment for this page. Check the result with `curl -I https://atlas.example.com/api/health`.

### Allowed host names

While authentication is off, the app only answers requests addressed to a host name it knows, and replies `421` with `This host name is not allowed` to anything else. This stops a hostile web page from reaching an unprotected deployment through a DNS name it controls.

Always accepted: `localhost`, IP addresses, single-label names such as `atlas-server`, and `.local` names. A name with a dot in it, such as `atlas.example.com`, must be the host of `PUBLIC_BASE_URL` or be listed in `ALLOWED_HOSTS`.

With authentication on the check is not enforced; an unknown host name is only logged.

---

## External PostgreSQL

The stack brings its own PostgreSQL container. You can point the web container at a database server you run yourself instead.

**Requirements**

- PostgreSQL 16. That is the version the stack ships and is tested with.
- An empty database, and a role that owns it. The migrations create every table, view and index themselves.
- The `pg_trgm` extension must be installable by that role. It ships with PostgreSQL; managed services often require you to allow it first (on Azure Database for PostgreSQL: add `PG_TRGM` to the `azure.extensions` server parameter). No other extension is needed.

**Settings.** `docker-compose.prod.yml` fixes the database host to the bundled container, so override it in a second compose file (the same one as for the reverse proxy):

```yaml
services:
  web:
    environment:
      POSTGRES_HOST: "db.example.com"
      POSTGRES_PORT: "5432"
      PGSSLMODE: "require"
```

`POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` in `.env` then describe the external database. `PGSSLMODE=require` makes the connection use TLS and verify the server's certificate. Alternatively, set a single `DATABASE_URL` (`postgres://user:password@host:5432/database`); when it is set it wins over the separate variables.

Two things to know:

- The bundled `postgres` container still starts, because the web container waits for it. It stays empty and unused. To remove it, edit your copy of the compose file.
- Backups, upgrades and tuning of an external database are yours. The `pg_dump` procedure on [Back up, restore and upgrade](../admin/backup-restore-upgrade.md) runs inside the bundled container and does not cover it.

!!! note "Not tested end to end"
    The variables are the ones the web container reads (`app/api/src/db/connection.js`), and the Azure deployment runs on an external PostgreSQL 16 with exactly these. The compose override itself was written from the compose file and not run for this page.

---

## Stopping and starting

```bash
# Stop the containers, keep all data
docker compose -f docker-compose.prod.yml down

# Start again
docker compose -f docker-compose.prod.yml up -d

# Logs of one service
docker compose -f docker-compose.prod.yml logs --tail 200 web
```

`down -v` also deletes the volumes: the database, the uploaded files and an auto-generated master key. See [Uninstall](../admin/backup-restore-upgrade.md#uninstall).

### A shell in the worker

The worker container has PowerShell 7 and the crawler scripts. For a one-off look inside:

```bash
docker compose -f docker-compose.prod.yml exec worker pwsh
```

---

## Running from source

Contributors build the images from a clone of the repository with `docker-compose.yml` instead of pulling them. That file falls back to a fixed local database password and ignores `IMAGE_TAG`, so use it for development only.

=== "Linux / macOS"

    ```bash
    cp setup/config/.env.example .env

    # The first build takes a few minutes
    docker compose up -d --build

    docker compose ps
    ```

=== "Windows (PowerShell)"

    ```powershell
    Copy-Item setup/config/.env.example .env

    # The first build takes a few minutes
    docker compose up -d --build

    docker compose ps
    ```

The UI is on `http://localhost:3001`, the API documentation on `http://localhost:3001/api/docs`.

After a code change, rebuild the service it belongs to:

```bash
# API and UI changes
docker compose up -d --build web

# Crawler and other PowerShell changes
docker compose up -d --build worker

# Stop (keep data) / stop and delete all data
docker compose down
docker compose down -v
```

| In the repository | In the image | Service |
|---|---|---|
| `app/api/src/` | `/app/backend/src/` | web |
| `app/ui/` (built) | `/app/frontend/dist/` | web |
| `tools/crawlers/` | `/app/tools/crawlers/` | worker |

To run a pre-built image without a local build, use `docker-compose.prod.yml` with `IMAGE_TAG=edge`.
