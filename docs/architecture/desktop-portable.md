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

Database files are stored in `pgdata\` under the data directory (see [Data Location](#data-location)) and persist across restarts.

A package built with `--with-postgres` also carries a real PostgreSQL server and runs that instead — see [Real PostgreSQL mode](#real-postgresql-mode).

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

All persistent data lives in one data directory, chosen in this order: `IA_DATA_DIR` when set; `%APPDATA%\IdentityAtlas\` when an older install already keeps its `pgdata\` there; otherwise `%LOCALAPPDATA%\IdentityAtlas\`. The launcher prints the one it uses.

| Path | Contents |
|---|---|
| `pgdata\` | PGlite database files |
| `postgres\` | Real PostgreSQL mode only: `data\` (the cluster), `password` (owner-only), `startup.log` |
| `uploads\` | CSV uploads and crawler configs |
| `jobs\` | Crawler job trace logs |
| `.master-key` | Encryption key for stored secrets |
| `.builtin-worker-key` | Internal API key for the crawler worker |
| `startup-error.log` | Written when the app stops on an unexpected error — send this file along with a bug report |
| `launcher.lock`, `launcher.state.json` | Keep two launchers off one data directory; let the next start recognise a leftover process |

To back up all data, stop the app and copy this folder. To reset to a clean state, delete it (the app re-initializes on next start).

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

The PGlite rows do not apply in [real PostgreSQL mode](#real-postgresql-mode), which behaves like Docker for all of them except multi-user access.

---

## Real PostgreSQL mode

PGlite has a hard ceiling that no setting moves. It is PostgreSQL compiled to 32-bit WebAssembly inside `node.exe`, so it can never address more than 4 GB. Its buffer pool is fixed at 128 MB and `work_mem` at 4 MB, and `ALTER SYSTEM` is accepted but ignored after a restart. It is also single-threaded. A tenant of 200k users, 800k entitlements and tens of millions of assignments (15–25 GB of tables and indexes) cannot fit.

A package built with `--with-postgres` therefore carries a real PostgreSQL 16 server in `postgres\`, unpacked from the official Windows binaries zip. `Start-IdentityAtlas.ps1` then runs **two processes**, both as the current user, with no installation and no administrator rights:

1. **PostgreSQL**, started with `pg_ctl` from `postgres\bin`, listening on `127.0.0.1:5433`.
2. **`node.exe bootstrap.mjs`**, given `POSTGRES_HOST`/`POSTGRES_PORT`/… instead of starting PGlite. `DESKTOP_MODE` is left off, so migrations install `pg_trgm` for real and matview refreshes use `CONCURRENTLY`. The API is still pinned to `127.0.0.1`.

The launcher waits until the API reports its schema migrated, opens the browser, and on Ctrl+C stops `node.exe` first and then PostgreSQL with `pg_ctl stop -m fast` (a clean shutdown: no recovery needed on the next start).

!!! danger "Check application control before relying on this mode"
    `node.exe` passes WDAC because the OpenJS Foundation signs it. **The PostgreSQL server binaries carry no Authenticode signature at all.** This was checked on 2026-09-26 with `Get-AuthenticodeSignature` against EDB's Windows binaries zip for 16.15, 17.8 and 18.4. `postgres.exe`, `initdb.exe`, `pg_ctl.exe`, `psql.exe`, `pg_isready.exe`, `libpq.dll` and all other server files report `NotSigned`. The only EnterpriseDB-signed file in the archive is `stackbuilder.exe`, which is not shipped.

    A policy that trusts publishers will therefore block these files. They can only run on such a machine if IT adds **hash rules** for the shipped `postgres\` files (for example with `New-CIPolicy -Level Hash -ScanPath <folder>\postgres`) or a path rule. The launcher detects a refusal before it creates anything. On a fresh data directory it falls back to PGlite with a warning that says why.

    The server also needs **`VCRUNTIME140.dll`** (the Microsoft Visual C++ 2015–2022 x64 redistributable), which the zip does not contain. Most machines have it. When it is missing, the same preflight reports it by name and falls back.

### Using it

```powershell
pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1
```

| Parameter | Default | Meaning |
|---|---|---|
| `-Database` | `Auto` | `Auto` uses PostgreSQL when `postgres\` is present, **except** on a data directory that already holds PGlite data. `Postgres` or `PGlite` forces one. |
| `-PostgresRoot` | `postgres\` next to the script | A folder containing `bin\pg_ctl.exe`, to use binaries kept elsewhere |
| `-PostgresPort` | `5433` | Loopback port for PostgreSQL. It differs from 5432 so it cannot collide with an installed server |
| `-Port` | `3001` | Loopback port for the app |
| `-StartupTimeoutSec` | `300` | When to warn that startup is slow. The launcher keeps waiting and **never kills a process that is still starting**, because on a large database that kill is what makes the next start slower |
| `-NoBrowser` | off | Do not open the browser |

Setting `DATABASE_URL` or `POSTGRES_HOST` before starting the launcher points the app at an existing server instead, and the launcher starts none.

**Switching an existing install from PGlite to PostgreSQL does not move its data.** Run once with `-Database Postgres` and re-import (run the crawlers again). The PGlite data stays in `pgdata\` untouched, and `-Database PGlite` returns to it.

### What the launcher does

- **First run.** It writes a random password to `postgres\password`, restricted to the current user, and runs `initdb` with `scram-sha-256` authentication, UTF-8 encoding and the C locale. It then appends a tuning block to `postgresql.conf`, starts the server and creates the `identityatlas` database. initdb writes into `data.initializing`, and the folder is renamed to `data` only once it is complete, so an interrupted first run is discarded and redone rather than half-used.
- **Tuning.** The block is sized from the machine's memory and written once. It stays visible and editable in `postgresql.conf`:

    | Setting | Rule | 16 GB laptop |
    |---|---|---|
    | `shared_buffers` | ¼ of RAM, 128 MB – 8 GB | 4 GB |
    | `effective_cache_size` | ½ of RAM, 256 MB – 32 GB | 8 GB |
    | `work_mem` | RAM ÷ 256, 4 – 128 MB | 64 MB |
    | `maintenance_work_mem` | RAM ÷ 16, 64 MB – 2 GB | 1 GB |
    | `max_wal_size` | 8 GB from 8 GB of RAM, else 2 GB | 8 GB |

    It also sets `listen_addresses = '127.0.0.1'` and turns on the logging collector, which writes a weekly ring of logs in `postgres\data\log\`.
- **Every start.** `-V` preflight of the binaries, `pg_ctl start`, then a wait for `pg_isready`. While the server is recovering the launcher keeps waiting; if the server exits instead, it fails at once with the tail of `postgres\startup.log`.
- **One launcher per data directory.** A second launcher on the same data directory leaves the first alone. It opens the browser if the app is ready and otherwise says it is still starting.
- **Leftovers.** PostgreSQL runs in its own hidden console, so closing the launcher window cannot kill it mid-write. A hidden watchdog (`Watch-IdentityAtlas.ps1`) waits for the launcher to end, however it ends (Ctrl+C, closed window, killed process), and then stops what is left: the recorded `node.exe`, then PostgreSQL with a fast shutdown. If even that is missed, the next start recognises and stops a leftover `node.exe` (by process id *and* start time) and restarts a leftover server cleanly.

### Measured

Measured on 2026-09-26 on an 8 GB Windows 11 machine, as a non-administrator, from a freshly extracted zip:

| Step | Time |
|---|---|
| First start (initdb, 74 migrations, bootstrap) to "running" | 14–15 s |
| Restart with data | 4–5 s |
| Start after an unclean stop (crash recovery) | 9 s |
| Ctrl+C to nothing left running | 2–3 s, clean shutdown checkpoint |
| Closed window / killed launcher to nothing left running | 0.3–2.4 s, clean shutdown checkpoint |

The zip grows from ~56 MB to ~80 MB with `postgres\` included: 1,112 files, 63 MB unpacked. The subset omits pgAdmin, StackBuilder, headers, docs and translations.

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

#### Embedding PostgreSQL

```powershell
npm run build:node-launcher:postgres
# or add the flag to any variant:
node ../desktop/scripts/build-node-launcher.mjs --skip-ui-build --with-postgres
```

This downloads EDB's PostgreSQL Windows binaries zip. The version and SHA-256 are pinned in `app/desktop/scripts/postgres-bundle.mjs`, and every build checks the hash. The zip is cached in `dist-node-launcher/` and only the subset the server needs is copied into `postgres\`. Binaries are never downloaded at run time, so the package works offline. Release builds do not use the flag.

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

The app binds to `127.0.0.1:3001` only, and in real PostgreSQL mode the database binds to `127.0.0.1:5433` only, so neither is reachable from other machines. Authentication is disabled by default, which means any process on this machine can call the API. Enable authentication (Admin → Authentication) on a shared machine.

In real PostgreSQL mode the database requires a password (`scram-sha-256`, no `trust` entries). The password is random per install and stored in `postgres\password`, readable only by the current user.

**Secret storage**

The master encryption key is stored in `%APPDATA%\IdentityAtlas\.master-key` (plain text, user-only access). Crawler credentials are stored encrypted using AES-256-GCM in the database.
