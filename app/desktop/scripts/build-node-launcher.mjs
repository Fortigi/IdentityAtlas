// Build script for the Identity Atlas portable node launcher.
//
// Produces dist-node-launcher/IdentityAtlas-portable.zip containing:
//   node.exe              — signed Node.js 24 binary (OpenJS Foundation cert)
//   bootstrap.mjs         — ESM entry point
//   app-bundle.mjs        — esbuild bundle of the API
//   migrations/           — SQL migration files
//   @electric-sql/pglite/ — PGlite WebAssembly package
//   desktop-worker.cjs    — crawler job dispatcher
//   dist-frontend/        — built React UI
//   Start-IdentityAtlas.ps1
//
// Usage (from repo root or app/api/):
//   node app/desktop/scripts/build-node-launcher.mjs [--skip-ui-build]
//
// Requires: node 18+, PowerShell 7+ on PATH (for Invoke-WebRequest + Compress-Archive)

import { execSync }                    from 'child_process';
import { cpSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'fs';
import { join, resolve, dirname }      from 'path';
import { fileURLToPath }               from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = resolve(__dirname, '..', '..', '..');
const API_ROOT    = join(REPO_ROOT, 'app', 'api');
const DESKTOP_DIR = join(REPO_ROOT, 'app', 'desktop');
const DIST_DIR    = join(API_ROOT, 'dist-node-launcher');
const STAGE_DIR   = join(DIST_DIR, 'stage');
const ZIP_PATH    = join(DIST_DIR, 'IdentityAtlas-portable.zip');

const NODE_VERSION = '24.16.0';
const NODE_URL     = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;

const SKIP_UI = process.argv.includes('--skip-ui-build');

function run(cmd, opts = {}) {
  console.log(`  > ${cmd.slice(0, 100)}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function pwsh(script) {
  run(`pwsh -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`);
}

// ── Step 0/8 — install API node_modules ──────────────────────────────────────
console.log('\n[1/8] Installing API dependencies...');
run('npm install --prefer-offline', { cwd: API_ROOT });

// ── Step 1/8 — build React UI ─────────────────────────────────────────────────
if (!SKIP_UI) {
  console.log('\n[2/8] Building React UI...');
  const UI_ROOT = join(REPO_ROOT, 'app', 'ui');
  run('npm install --prefer-offline', { cwd: UI_ROOT });
  run('npm run build', { cwd: UI_ROOT });
} else {
  console.log('\n[2/8] Skipping UI build (--skip-ui-build)');
}

// ── Step 2/8 — clean staging area ────────────────────────────────────────────
console.log('\n[3/8] Preparing staging area...');
if (existsSync(STAGE_DIR)) rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });

// ── Step 3/8 — esbuild API bundle ────────────────────────────────────────────
console.log('\n[4/8] Bundling API with esbuild...');
const BUNDLE_OUT = join(STAGE_DIR, 'app-bundle.mjs');
run(
  `node node_modules/.bin/esbuild src/index.js` +
  ` --bundle --platform=node --format=esm` +
  ` --outfile="${BUNDLE_OUT}"` +
  ` --external:@electric-sql/pglite` +
  ` --external:pg-native`,
  { cwd: API_ROOT }
);

// ── Step 4/8 — copy migrations ───────────────────────────────────────────────
console.log('\n[5/8] Copying migrations...');
cpSync(
  join(API_ROOT, 'src', 'db', 'migrations'),
  join(STAGE_DIR, 'migrations'),
  { recursive: true }
);

// ── Step 5/8 — copy PGlite ───────────────────────────────────────────────────
console.log('\n[6/8] Copying @electric-sql/pglite...');
const PGLITE_SRC  = join(DESKTOP_DIR, 'node_modules', '@electric-sql', 'pglite');
const PGLITE_DEST = join(STAGE_DIR, '@electric-sql', 'pglite');
mkdirSync(join(STAGE_DIR, '@electric-sql'), { recursive: true });
cpSync(PGLITE_SRC, PGLITE_DEST, { recursive: true });

// ── Step 6/8 — copy launcher files ───────────────────────────────────────────
console.log('\n[7/8] Copying launcher files...');
const LAUNCHER_SRC = join(DESKTOP_DIR, 'node-launcher');
copyFileSync(join(LAUNCHER_SRC, 'bootstrap.mjs'),             join(STAGE_DIR, 'bootstrap.mjs'));
copyFileSync(join(LAUNCHER_SRC, 'Start-IdentityAtlas.ps1'),   join(STAGE_DIR, 'Start-IdentityAtlas.ps1'));
copyFileSync(join(DESKTOP_DIR,  'desktop-worker.cjs'),        join(STAGE_DIR, 'desktop-worker.cjs'));

// Copy built React UI
const UI_DIST = join(REPO_ROOT, 'app', 'ui', 'dist');
if (existsSync(UI_DIST)) {
  cpSync(UI_DIST, join(STAGE_DIR, 'dist-frontend'), { recursive: true });
} else {
  console.warn('  WARNING: UI dist not found at', UI_DIST, '— dist-frontend will be missing from zip');
}

// ── Step 7/8 — download node.exe ─────────────────────────────────────────────
console.log('\n[8/8] Downloading node.exe...');
const NODE_DEST = join(STAGE_DIR, 'node.exe');
if (!existsSync(NODE_DEST)) {
  pwsh(`Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${NODE_DEST}' -UseBasicParsing`);
} else {
  console.log('  node.exe already present, skipping download');
}

// ── Step 8/8 — zip ───────────────────────────────────────────────────────────
console.log('\n[8/8] Creating zip...');
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
pwsh(`Compress-Archive -Path '${STAGE_DIR}\\*' -DestinationPath '${ZIP_PATH}'`);

console.log(`\nDone! Output: ${ZIP_PATH}`);
