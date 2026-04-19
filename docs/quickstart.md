# Quick Start

Identity Atlas runs as a Docker stack — no Azure subscription, no git clone required. Just Docker.

=== "Linux / macOS"

    ```bash
    # Download the compose file
    curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml

    # Start everything (--pull always forces Docker to fetch the newest
    # :latest image from ghcr.io instead of reusing a cached copy)
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

=== "Windows (PowerShell)"

    ```powershell
    # Download the compose file
    Invoke-WebRequest `
        -Uri https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml `
        -OutFile docker-compose.prod.yml

    # Start everything (--pull always forces Docker to fetch the newest
    # :latest image from ghcr.io instead of reusing a cached copy)
    docker compose -f docker-compose.prod.yml up -d --pull always
    ```

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

## Upgrading to a new version

Identity Atlas publishes new images to `ghcr.io/fortigi/identity-atlas{,-worker}` on every push to `main`. The `:latest` tag always points at the newest build, and each build also gets a version-stamped tag (`5.0.yyyyMMdd.HHmm`) for reproducible deployments.

To upgrade an existing deployment to the newest version:

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

1. **Dashboard** — open [http://localhost:3001](http://localhost:3001); the Version card on the right shows `v5.0.yyyyMMdd.HHmm`.
2. **API endpoint** — `Invoke-RestMethod http://localhost:3001/api/version` (or `curl` on Linux/macOS). Returns `{ "version": "5.0.yyyyMMdd.HHmm" }`.
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
| Importing from non-Entra systems | [CSV Sync](sync/csv-import.md) |
