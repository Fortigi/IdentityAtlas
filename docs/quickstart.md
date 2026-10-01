---
type: start
prereq: none
outcome: Identity Atlas is running on your machine with the demo data loaded.
---

# Quick Start

!!! info "Where this sits"
    This is a *Start here* page — it assumes nothing. New to Identity Atlas?
    [The words you need first](start/glossary.md) is the eight minutes that make everything else readable.

Identity Atlas runs as a Docker stack — no Azure subscription, no git clone required. All you need is Docker and a one-line `.env` that sets a database password; the commands below generate it for you.

=== "Linux / macOS"

    ```bash
    # Download the compose file
    curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml

    # Create .env with a generated database password (skipped when .env already exists)
    [ -f .env ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env

    # Start everything (--pull always forces Docker to fetch the newest
    # :latest image from ghcr.io instead of reusing a cached copy)
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

=== "Windows (PowerShell)"

    ```powershell
    # Download the compose file
    Invoke-WebRequest -Uri https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml -OutFile docker-compose.prod.yml

    # Create .env with a generated database password (skipped when .env already exists)
    if (-not (Test-Path .env)) {
        $bytes = [byte[]]::new(24)
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        "POSTGRES_PASSWORD=$(-join ($bytes | ForEach-Object { $_.ToString('x2') }))" | Set-Content .env -Encoding ascii
    }

    # Start everything (--pull always forces Docker to fetch the newest
    # :latest image from ghcr.io instead of reusing a cached copy)
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

!!! warning "`POSTGRES_PASSWORD` is required"
    The production compose file ships no default database password and refuses to
    start until `.env` (or your shell) sets a non-empty `POSTGRES_PASSWORD`. The
    commands above write a random one; nothing else in `.env` is required.

    The password is only generated when there is no `.env` yet, so running the
    commands again is safe. Keep the file: the database keeps the password it was
    first created with, and a different value in `.env` would lock the app out of
    its own database. If you already have a `.env` without a password, add a
    `POSTGRES_PASSWORD=<strong value>` line to it instead.

!!! note "Before you put real data in it"
    This stack is set up for evaluation. Two things to settle first:

    - **Sign-in is off.** The Docker stack starts in open mode
      (`AUTH_ENABLED=false`): anyone who can reach port 3001 has full access.
      [Set up authentication](admin/authentication.md) before you share it.
    - **Know where the vault key is.** Stored crawler and LLM credentials are
      encrypted with a master key. With `IDENTITY_ATLAS_MASTER_KEY` unset, the
      web container generates one on first start and keeps it in the `web_keys`
      Docker volume. Without that key the stored credentials cannot be
      decrypted, so either back the volume up, or set
      `IDENTITY_ATLAS_MASTER_KEY` in `.env` before the first start to a value
      you keep yourself (32 random bytes, base64-encoded:
      `openssl rand -base64 32`).

    [Docker Setup](architecture/docker-setup.md#environment-variables) lists
    every variable.

!!! tip "Why `--pull always`?"
    Without `--pull always`, `docker compose up` only pulls an image if it isn't already cached locally. If you ran Identity Atlas before, Docker will happily reuse yesterday's `:latest` — even though a newer `:latest` may be on ghcr.io. Adding `--pull always` forces a registry check on every start. Requires Docker Compose v2.22 or later; on older versions, run `docker compose pull` first and then `up -d`.

Open [http://localhost:3001](http://localhost:3001). The app opens to the Dashboard. If no data is loaded yet, click **"Configure a crawler"** to go to Admin → Crawlers, then click **"Load Demo Data"** to explore with synthetic data (~30 seconds).

To connect your own Entra ID tenant, click **"Connect Entra ID"** and enter your App Registration credentials directly in the browser. The wizard walks you through credential validation, object type selection, identity filtering, custom attributes, and scheduling.

See [Docker Setup](architecture/docker-setup.md) for details on environment variables and volumes, and [Scaling & Load Testing](architecture/scaling.md) for sizing guidance.

---

## Verifying the deployment

After `docker compose up`, you should have three containers running:

```bash
docker compose ps
# Expected: postgres (healthy), web (up), worker (up)
```

A few quick checks:

=== "Linux / macOS"

    ```bash
    # Health endpoint
    curl http://localhost:3001/api/health
    # {"status":"ok"}

    # System status (hasData=false on a fresh install, hasCrawlers=true after auto-bootstrap)
    curl http://localhost:3001/api/admin/status
    ```

=== "Windows (PowerShell)"

    ```powershell
    # Health endpoint
    Invoke-RestMethod http://localhost:3001/api/health
    # status : ok

    # System status (hasData=false on a fresh install, hasCrawlers=true after auto-bootstrap)
    Invoke-RestMethod http://localhost:3001/api/admin/status
    ```

Open the UI at [http://localhost:3001](http://localhost:3001) and the Admin → Crawlers page should show a "Welcome" card.

---

## Image channels

Identity Atlas publishes three channels:

| Channel | Tag | Updated when | Use it for |
|---------|-----|-------------|-----------|
| **Stable** | `:latest` | A new release is cut (e.g. `v5.2.0`) | Customers and production — default |
| **Beta** | `:beta` | A pre-release is cut via Actions → Cut Beta | Beta testers |
| **Edge** | `:edge` | Every PR merges to `main` | Developers and testers who want unreleased features |

Stable and beta channels also publish an exact version tag (`:5.2.0.0`, `:5.3.0-beta.1`) at the same time, so you can pin to a specific build.

=== "Linux / macOS"

    ```bash
    # Default: pull the latest stable release
    docker compose -f docker-compose.prod.yml up -d --pull always

    # Beta: latest pre-release build
    IMAGE_TAG=beta docker compose -f docker-compose.prod.yml up -d --pull always

    # Edge: latest commit on main (may include unreleased features)
    IMAGE_TAG=edge docker compose -f docker-compose.prod.yml up -d --pull always
    ```

=== "Windows (PowerShell)"

    ```powershell
    # Default: pull the latest stable release
    docker compose -f docker-compose.prod.yml up -d --pull always

    # Beta: latest pre-release build
    $env:IMAGE_TAG = "beta"
    docker compose -f docker-compose.prod.yml up -d --pull always

    # Edge: latest commit on main (may include unreleased features)
    $env:IMAGE_TAG = "edge"
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

---

## Upgrading to a new version

To upgrade an existing deployment to the newest stable release:

=== "Linux / macOS"

    ```bash
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

=== "Windows (PowerShell)"

    ```powershell
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

The database volume is preserved across upgrades — any data you have loaded stays put. Schema migrations run automatically on container start; if a new version needs a new table or column, the web container will apply it before serving traffic.

### Checking the running version

Three ways to see which version is currently deployed:

1. **Dashboard** — open [http://localhost:3001](http://localhost:3001); the Version card in the footer shows the version. Stable releases show `v5.2.0.0`; edge builds show `v5.3.20260419.1430` with an amber **edge** badge.
2. **API endpoint** — `Invoke-RestMethod http://localhost:3001/api/version` (or `curl` on Linux/macOS). Returns `{ "version": "5.2.0.0" }`.
3. **Docker directly** — `docker compose -f docker-compose.prod.yml images` lists the image tag each container is running.

Compare that against the newest tag on [ghcr.io/fortigi/identity-atlas](https://github.com/Fortigi/IdentityAtlas/pkgs/container/identity-atlas) to see whether an upgrade is available.

### Pinning to a specific version

If you want a reproducible deployment (e.g. production) instead of always tracking `:latest`, edit `docker-compose.prod.yml` and replace:

```yaml
image: ghcr.io/fortigi/identity-atlas:latest
image: ghcr.io/fortigi/identity-atlas-worker:latest
```

with the explicit version tag:

```yaml
image: ghcr.io/fortigi/identity-atlas:5.2.0.0
image: ghcr.io/fortigi/identity-atlas-worker:5.2.0.0
```

Both images are always published with the same version tag, so they'll stay in sync.

---

## What's Next

| Topic | Where to go |
|-------|------------|
| Understanding the data model | [Data Model](concepts/data-model.md) |
| UI features and navigation | [UI Overview](ui/overview.md) |
| Risk scoring deep dive | [Risk Scoring Overview](risk-scoring/overview.md) |
| Troubleshooting | [Troubleshooting](reference/troubleshooting.md) |
| Connecting your Entra ID tenant | [Entra ID Sync](sync/entra-id.md) |
| Importing from non-Entra systems | [CSV Sync](sync/csv-import.md) |
