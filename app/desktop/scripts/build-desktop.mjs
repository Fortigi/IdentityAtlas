#!/usr/bin/env node
// Build script for the IdentityAtlas desktop app.
//
//   1. Build the React UI (app/ui → app/ui/dist/)
//   2. Copy dist/ to app/api/dist-frontend/ (electron-builder extraResource)
//   3. Copy PowerShell crawler scripts to app/api/bundled-scripts/ (extraResource)
//   4. esbuild: bundle src/index.js → src/app-bundle.mjs  (ESM + CJS compat banner)
//              bundle embedded-postgres → src/embedded-postgres-bundle.cjs (pg bundled inline)
//   5. electron-builder --win → app/api/dist-electron/IdentityAtlas.exe (~300 MB, portable)
//
// Usage (from app/api/):
//   npm run build:desktop              — full build including React UI
//   npm run build:desktop:skip-ui      — skip the React UI build step

import { execSync }              from 'child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath }         from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, '..');        // app/desktop/scripts/ → app/desktop/
const API_ROOT     = resolve(__dirname, '../../api'); // app/desktop/scripts/ → app/api/
const REPO_ROOT    = resolve(API_ROOT,  '../..');     // app/api/ → repo root
const UI_ROOT      = resolve(REPO_ROOT, 'app/ui');   // app/ui/

const FRONTEND_DIST_SRC  = join(UI_ROOT,  'dist');
const FRONTEND_DIST_DEST = join(API_ROOT, 'dist-frontend');
const SCRIPTS_SRC        = REPO_ROOT;
const SCRIPTS_DEST       = join(API_ROOT, 'bundled-scripts');

const skipUiBuild = process.argv.includes('--skip-ui-build');

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: cwd || API_ROOT, stdio: 'inherit' });
}

// ─── Step 1: Build React UI ───────────────────────────────────────────────────
if (!skipUiBuild) {
  console.log('\n[1/5] Building React UI...');
  run('npm ci --prefer-offline', UI_ROOT);
  run('npm run build', UI_ROOT);
} else {
  console.log('\n[1/5] Skipping UI build (--skip-ui-build)');
}

if (!existsSync(FRONTEND_DIST_SRC)) {
  throw new Error(`UI build output not found at ${FRONTEND_DIST_SRC}. Run without --skip-ui-build.`);
}

// ─── Step 2: Copy frontend dist ──────────────────────────────────────────────
console.log('\n[2/5] Copying frontend dist...');
if (existsSync(FRONTEND_DIST_DEST)) rmSync(FRONTEND_DIST_DEST, { recursive: true, force: true });
cpSync(FRONTEND_DIST_SRC, FRONTEND_DIST_DEST, { recursive: true });
console.log(`  → ${FRONTEND_DIST_DEST}`);

// ─── Step 3: Copy PowerShell scripts ─────────────────────────────────────────
// Bundled layout mirrors the Docker container's /app/ layout so IA_APP_ROOT
// points to the same relative structure that scheduler.ps1 expects.
console.log('\n[3/5] Copying PowerShell scripts...');
if (existsSync(SCRIPTS_DEST)) rmSync(SCRIPTS_DEST, { recursive: true, force: true });

const SCRIPTS_TO_BUNDLE = [
  'setup/docker/Invoke-CrawlerJob.ps1',
  'setup/docker/scheduler.ps1',
  'setup/docker/Build-FGContexts.ps1',
  'setup/IdentityAtlas.psd1',
  'tools/crawlers/entra-id/Start-EntraIDCrawler.ps1',
  'tools/crawlers/csv/Start-CSVCrawler.ps1',
];

const DIRS_TO_BUNDLE = [
  'Functions',
  'test/demo-dataset',   // gitignored but present locally; warn if missing
];

for (const file of SCRIPTS_TO_BUNDLE) {
  const src  = join(SCRIPTS_SRC, file);
  const dest = join(SCRIPTS_DEST, file);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(src)) {
    cpSync(src, dest);
  } else {
    console.warn(`  WARNING: ${file} not found — skipping`);
  }
}

for (const dir of DIRS_TO_BUNDLE) {
  const src  = join(SCRIPTS_SRC, dir);
  const dest = join(SCRIPTS_DEST, dir);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
  } else {
    console.warn(`  WARNING: ${dir}/ not found — skipping`);
  }
}

console.log(`  → ${SCRIPTS_DEST}`);

// ─── Step 4: Bundle with esbuild ─────────────────────────────────────────────
console.log('\n[4/5] Bundling Express app + embedded-postgres with esbuild...');

// 4a: Express app → ESM (top-level await in routes requires ESM format).
// --banner:js injects CJS compat polyfills:
//   require        — lets esbuild's __require shim fall back to Node's built-in require()
//   __filename/__dirname — fallback for CJS factories that use them (e.g. swagger-ui-dist)
// Aliased imports avoid colliding with esbuild's own imports inside the bundle body.
const APP_BUNDLE = join(API_ROOT, 'src', 'app-bundle.mjs');
run(
  `npx esbuild src/index.js ` +
  `--bundle ` +
  `--platform=node ` +
  `--format=esm ` +
  `--outfile=${APP_BUNDLE} ` +
  `--external:pg-native ` +
  `--banner:js="import { createRequire as __cjs_createRequire } from 'module'; import { fileURLToPath as __cjs_fileURLToPath } from 'url'; import { dirname as __cjs_dirname } from 'path'; const require = __cjs_createRequire(import.meta.url); const __filename = __cjs_fileURLToPath(import.meta.url); const __dirname = __cjs_dirname(__filename);" ` +
  `--log-level=warning`
);
console.log(`  → ${APP_BUNDLE}`);

// 4b: embedded-postgres → CJS so main.js can require() it from extraResources.
// pg is bundled inline (not external) because extraResources has no node_modules.
// All non-windows platform packages are external — dead code on win32.
const EP_BUNDLE = join(API_ROOT, 'src', 'embedded-postgres-bundle.cjs');
run(
  `npx esbuild node_modules/embedded-postgres/dist/index.js ` +
  `--bundle ` +
  `--platform=node ` +
  `--format=cjs ` +
  `--outfile=${EP_BUNDLE} ` +
  `--external:@embedded-postgres/darwin-arm64 ` +
  `--external:@embedded-postgres/darwin-x64 ` +
  `--external:@embedded-postgres/linux-arm ` +
  `--external:@embedded-postgres/linux-arm64 ` +
  `--external:@embedded-postgres/linux-ia32 ` +
  `--external:@embedded-postgres/linux-ppc64 ` +
  `--external:@embedded-postgres/linux-x64 ` +
  `--log-level=warning`
);
console.log(`  → ${EP_BUNDLE}`);

// ─── Step 5: electron-builder ────────────────────────────────────────────────
console.log('\n[5/5] Building Electron app (installs electron on first run)...');
run('npm install --prefer-offline', DESKTOP_ROOT);
run('npx electron-builder --win', DESKTOP_ROOT);

const OUTPUT_EXE = join(API_ROOT, 'dist-electron', 'IdentityAtlas.exe');
console.log(`\n✓ Build complete: ${OUTPUT_EXE}`);
