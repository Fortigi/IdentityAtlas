# Portable Windows Launcher

Identity Atlas can run as a standalone portable ZIP on Windows — no Docker, no WSL, no administrator rights, no installation. Unzip and run a PowerShell script to start the full stack.

This deployment mode is designed for environments where Docker and WSL are blocked by security policy.

---

## How It Works

`IdentityAtlas-portable.zip` bundles:

- `node.exe` — the official Node.js 24 binary, signed by the **OpenJS Foundation** (trusted by enterprise WDAC / application-control policies)
- `bootstrap.mjs` — ESM entry point that initializes PGlite and starts the API
- `app-bundle.mjs` — esbuild bundle of the Express API
- `migrations/` — SQL migration files
- `@electric-sql/pglite/` — PGlite WebAssembly package
- `desktop-worker.cjs` — crawler job dispatcher
- `dist-frontend/` — the built React UI
- `Start-IdentityAtlas.ps1` — launcher script

### Why a signed node.exe?

Locked-down corporate laptops enforce **WDAC (Windows Defender Application Control)** — a kernel-level policy that blocks unsigned PE executables. Custom-signed or developer-built exe files are rejected even if you bypass SmartScreen.

`node.exe` from [nodejs.org](https://nodejs.org) is signed by the **OpenJS Foundation**, a trusted publisher in most enterprise WDAC publisher allow-lists. Running your app via a trusted `node.exe` avoids the signing barrier entirely.

### Architecture

```
IdentityAtlas-portable.zip (extracted)
  ├── node.exe              — signed Node.js binary (OpenJS Foundation cert)
  ├── bootstrap.mjs         — PGlite init + API bootstrap
  ├── app-bundle.mjs        — Express API bundle
  ├── migrations/           — SQL migrations
  ├── @electric-sql/pglite/ — PostgreSQL WebAssembly
  ├── desktop-worker.cjs    — crawler dispatcher (polls API for jobs)
  ├── dist-frontend/        — React UI static files
  └── Start-IdentityAtlas.ps1
```

`bootstrap.mjs` initializes PGlite (WebAssembly PostgreSQL) in-process, sets `DESKTOP_MODE=true`, then imports the API bundle. `connection.js` detects this flag and routes all database calls through the in-process PGlite instance instead of a TCP connection pool. No child process is spawned, no executable is written to disk at runtime.

Database files are stored in `%APPDATA%\IdentityAtlas\pgdata\` and persist across restarts.

---

## Running the Portable Launcher

### Prerequisites

| Requirement | Notes |
|---|---|
| **Windows 10/11 x64** | Only x64 builds are produced today |
| **PowerShell 7** (`pwsh.exe`) | Required to start the launcher and run crawlers. Install from [aka.ms/powershell](https://aka.ms/powershell) or `winget install Microsoft.PowerShell` |

No Docker. No WSL. No administrator rights.

### Starting the App

1. Download `IdentityAtlas-portable.zip` from the [GitHub Releases page](https://github.com/Fortigi/IdentityAtlas/releases)
2. Extract the zip to a folder of your choice (e.g. `C:\Users\YourName\IdentityAtlas\`)
3. Open PowerShell 7 and run:
   ```powershell
   pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1
   ```
4. The script starts the server and opens `http://localhost:3001` in your browser once it's ready (~5–10 seconds on first run)

On first run, load the bundled demo dataset to explore with synthetic data:

```powershell
.\bundled-scripts\test\demo-dataset\Ingest-DemoDataset.ps1 `
    -ApiKey (Get-Content "$env:APPDATA\IdentityAtlas\.builtin-worker-key")
```

Or go to **Admin → Crawlers** to connect your own data sources.

### Data Location

All persistent data lives under `%APPDATA%\IdentityAtlas\`:

| Path | Contents |
|---|---|
| `pgdata\` | PGlite database files |
| `uploads\` | CSV uploads and crawler configs |
| `jobs\` | Crawler job trace logs |
| `.master-key` | Encryption key for stored secrets |
| `.builtin-worker-key` | Internal API key for the crawler worker |

To back up all data, copy this folder. To reset to a clean state, delete it (the app re-initializes on next start).

### Crawlers

Crawlers run via PowerShell (`pwsh.exe`). The Entra ID and CSV crawlers are bundled inside the zip and dispatched automatically when you schedule or trigger a run from the Admin → Crawlers page.

If `pwsh.exe` is not on `PATH`, the UI will still load and display existing data, but attempting to run a crawler will fail with a clear error message.

### Limitations vs Docker

| Feature | Docker | Portable ZIP |
|---|---|---|
| PostgreSQL version | 16 (full) | PGlite (WASM, based on PG 16) |
| Concurrent users | Multi-user | Single machine, localhost only |
| `pg_class.reltuples` stats | Updated by ANALYZE | Always 0 — exact COUNT used instead |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | Supported | Not supported (no background worker) — plain REFRESH used |
| Background worker container | Separate process | Integrated, same Node.js process |
| Auth (Entra ID JWT) | Configurable | Disabled by default |
| Azure deployment | Via Bicep | N/A |

---

## Building the Portable ZIP

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 18 or later | [nodejs.org](https://nodejs.org) — the bundled `node.exe` is always Node.js 24 |
| **npm** | Comes with Node.js | |
| **PowerShell 7** | 7.x | Required to run the build script (downloads node.exe and creates the zip) |
| **Git** | Any | |
| **Windows** | Required | The build script downloads `win-x64/node.exe` and uses `Compress-Archive` |

### Steps

```powershell
# 1. Clone the repository
git clone https://github.com/Fortigi/IdentityAtlas.git
cd IdentityAtlas

# 2. Install desktop dependencies (includes PGlite)
cd app/desktop
npm install

# 3. Run the build (from app/api/)
cd ../api
npm install
npm run build:node-launcher
```

The build script (`app/desktop/scripts/build-node-launcher.mjs`) does eight steps:

1. Installs API dependencies (`npm install`)
2. Builds the React UI (`app/ui → app/ui/dist/`)
3. Cleans the staging area (`dist-node-launcher/stage/`)
4. Bundles the Express API with esbuild → `app-bundle.mjs`
5. Copies SQL migrations alongside the bundle
6. Copies `@electric-sql/pglite` from `app/desktop/node_modules/`
7. Copies launcher files (`bootstrap.mjs`, `Start-IdentityAtlas.ps1`, `desktop-worker.cjs`, UI dist)
8. Downloads `node.exe` from nodejs.org and creates `IdentityAtlas-portable.zip`

#### Skipping the UI build

If you've already built the UI and are iterating on the backend only:

```powershell
npm run build:node-launcher:skip-ui
```

#### Build Output

```
app/api/dist-node-launcher/
  IdentityAtlas-portable.zip   ← portable ZIP (~50 MB)
  stage/                       ← unpacked contents (can run directly for dev)
```

---

## Security Notes

**Why PGlite instead of embedded-postgres?**

The previous implementation used the `embedded-postgres` npm package, which extracts a `postgres.exe` binary to `%APPDATA%` at runtime and spawns it as a child process. Endpoint security tools (CrowdStrike, Defender for Endpoint, and others) flag this pattern — an exe extracting and executing another exe from a user-writable location.

PGlite runs PostgreSQL compiled to WebAssembly inside the Node.js process. Nothing is extracted to disk at runtime. The WASM module is part of the zip, loaded like any other Node.js module.

**Network exposure**

The app binds to `0.0.0.0:3001` (all interfaces). It is reachable from other machines on the same network. In a home or corporate LAN this is typically acceptable for a single-user local install, but be aware that authentication is disabled by default in desktop mode — do not use on untrusted networks without enabling `AUTH_ENABLED=true`.

**Secret storage**

The master encryption key is stored in `%APPDATA%\IdentityAtlas\.master-key` (plain text, user-only access). Crawler credentials are stored encrypted using AES-256-GCM in the database.
