# Portable Windows Desktop App

Identity Atlas can run as a standalone Windows `.exe` — no Docker, no WSL, no administrator rights, no installation. Double-click the file and the full stack starts inside a single process.

This deployment mode is designed for environments where Docker and WSL are blocked by security policy.

---

## How It Works

The portable exe is an Electron application that bundles:

- The React UI (served by Express)
- The Node.js API (Express, same code as the Docker `web` container)
- **PGlite** — PostgreSQL compiled to WebAssembly, running in-process

PGlite replaces the PostgreSQL container. It runs entirely inside the Electron process as a WebAssembly module — no child process is spawned, no executable is extracted to disk at runtime. This means the app passes endpoint security tools (CrowdStrike, Defender for Endpoint, etc.) that would block a subprocess-based embedded database.

Database files are stored in `%APPDATA%\IdentityAtlas\pgdata\` and persist across restarts.

### Architecture

```
IdentityAtlas.exe (Electron)
  ├── main.js          — app lifecycle, tray icon, PGlite init
  ├── app-bundle.mjs   — Express API (extraResource, loaded at runtime)
  └── PGlite (WASM)    — PostgreSQL in-process, data in %APPDATA%
       └── → serves http://localhost:3001
```

The Express bundle is loaded after PGlite is initialized. `connection.js` detects `DESKTOP_MODE=true` and routes all database calls through the in-process PGlite instance instead of a TCP connection pool.

---

## Running the Portable App

### Prerequisites

| Requirement | Notes |
|---|---|
| **Windows 10/11 x64** | Only x64 builds are produced today |
| **PowerShell 7** (`pwsh.exe`) | Optional — required only to run crawlers. Install from [aka.ms/powershell](https://aka.ms/powershell) or via winget: `winget install Microsoft.PowerShell` |

No Docker. No WSL. No administrator rights.

### Starting the App

1. Download `IdentityAtlas.exe` from the [GitHub Releases page](https://github.com/Fortigi/IdentityAtlas/releases) (or build it locally — see below)
2. Double-click the exe
3. A splash screen appears while PGlite initializes and migrations run (~5–10 seconds on first run)
4. The app window opens to `http://localhost:3001`
5. A system tray icon gives access to **Open** and **Quit**

On first run, click **Admin → Crawlers → Load Demo Data** to explore with synthetic data, or add a crawler to connect your own data sources.

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

Crawlers run via PowerShell (`pwsh.exe`). The Entra ID and CSV crawlers are bundled inside the exe and dispatched automatically when you schedule or trigger a run from the Admin → Crawlers page.

If `pwsh.exe` is not on `PATH`, the UI will still load and display existing data, but attempting to run a crawler will fail with a clear error message.

### Limitations vs Docker

| Feature | Docker | Portable .exe |
|---|---|---|
| PostgreSQL version | 16 (full) | PGlite (WASM) |
| Concurrent users | Multi-user | Single machine, localhost only |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | Supported | Falls back to non-concurrent refresh |
| Background worker container | Separate process | Integrated, same process |
| Auth (Entra ID JWT) | Configurable | Disabled by default |
| Azure deployment | Via Bicep | N/A |

---

## Building the Portable App

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20 LTS or later | [nodejs.org](https://nodejs.org) |
| **npm** | Comes with Node.js | |
| **PowerShell 7** | 7.x | Required for bundling crawler scripts |
| **Git** | Any | |
| **Windows** | For `--win` builds | Cross-compilation from Linux/macOS is not supported for the `.exe` target |

### Steps

```powershell
# 1. Clone the repository
git clone https://github.com/Fortigi/IdentityAtlas.git
cd IdentityAtlas

# 2. Install API dependencies
cd app/api
npm ci

# 3. Install desktop dependencies (includes PGlite)
cd ../desktop
npm install

# 4. Run the build (from app/api/)
cd ../api
npm run build:desktop
```

The build script does five things:

1. Builds the React UI (`app/ui → app/ui/dist/`)
2. Copies the UI dist to `app/api/dist-frontend/` (packaged as an extraResource)
3. Copies PowerShell crawler scripts to `app/api/bundled-scripts/`
4. Bundles the Express API with esbuild → `app/api/src/app-bundle.mjs`
5. Runs electron-builder → `app/api/dist-electron/IdentityAtlas.exe`

The output is a single portable `.exe` (~300 MB). No installation, no registry writes, no admin required.

#### Skipping the UI build

If you've already built the UI and are iterating on the backend only:

```powershell
npm run build:desktop:skip-ui
```

#### Dev mode (no build)

To run the app locally without building the exe:

```powershell
# Terminal 1 — start the API in watch mode
cd app/api
npm run dev

# Terminal 2 — start Electron against the dev API
cd app/desktop
npx electron .
```

This runs against your local `src/index.js` directly, skipping esbuild. Changes to the API are picked up after a restart.

### Build Output

```
app/api/dist-electron/
  IdentityAtlas.exe      ← portable executable (~300 MB)
```

The exe is self-contained. Copy it anywhere and run it.

---

## Security Notes

**Why PGlite instead of embedded-postgres?**

The previous implementation used the `embedded-postgres` npm package, which extracts a `postgres.exe` binary to `%APPDATA%` at runtime and spawns it as a child process. Endpoint security tools (CrowdStrike, Defender for Endpoint, and others) flag this pattern — an exe extracting and executing another exe from a user-writable location.

PGlite runs PostgreSQL compiled to WebAssembly inside the Electron process. Nothing is extracted to disk at runtime. The WASM module is part of the Electron bundle, installed to the app's own directory, and loaded like any other Node.js module.

**Network exposure**

The app binds to `127.0.0.1:3001` (loopback only). It is not accessible from other machines on the network. Authentication is disabled by default in desktop mode.

**Secret storage**

The master encryption key is stored in `%APPDATA%\IdentityAtlas\.master-key` (plain text, user-only access). Crawler credentials are stored encrypted using AES-256-GCM in the database.
