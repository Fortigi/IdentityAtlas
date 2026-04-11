# Quick Start

Identity Atlas runs as a Docker stack — no Azure subscription, no git clone required. Just Docker.

=== "Linux / macOS"

    ```bash
    # Download the compose file
    curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml

    # Start everything
    docker compose -f docker-compose.prod.yml up -d
    ```

=== "Windows (PowerShell)"

    ```powershell
    # Download the compose file
    Invoke-WebRequest `
        -Uri https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml `
        -OutFile docker-compose.prod.yml

    # Start everything
    docker compose -f docker-compose.prod.yml up -d
    ```

Open [http://localhost:3001](http://localhost:3001). The app auto-navigates to the **Crawlers** page. Click **"Load Demo Data"** to explore with synthetic data (~30 seconds).

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

## What's Next

| Topic | Where to go |
|-------|------------|
| Understanding the data model | [Data Model](concepts/data-model.md) |
| UI features and navigation | [UI Overview](ui/overview.md) |
| Risk scoring deep dive | [Risk Scoring Overview](risk-scoring/overview.md) |
| Troubleshooting | [Troubleshooting](reference/troubleshooting.md) |
| Importing from non-Entra systems | [CSV Sync](sync/csv-import.md) |
