#!/usr/bin/env node
// Build script for the IdentityAtlas desktop .exe.
//
// Steps:
//   1. Build the React UI (app/ui → app/ui/dist/)
//   2. Copy dist/ to app/api/dist-frontend/ (pkg bundles it as an asset from there)
//   3. Copy PowerShell crawler scripts to app/api/bundled-scripts/ (pkg asset)
//   4. Run @yao-pkg/pkg to produce dist/IdentityAtlas.exe
//
// Usage:
//   node scripts/build-desktop.js [--skip-ui-build]
//
// Output: app/api/dist/IdentityAtlas.exe  (~120 MB, node20-win-x64)

import { execSync }              from 'child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath }         from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT  = resolve(__dirname, '..');       // app/api/
const REPO_ROOT = resolve(API_ROOT, '../..');     // repo root
const UI_ROOT   = resolve(REPO_ROOT, 'app/ui');   // app/ui/

const FRONTEND_DIST_SRC  = join(UI_ROOT,  'dist');
const FRONTEND_DIST_DEST = join(API_ROOT, 'dist-frontend');
const SCRIPTS_SRC        = REPO_ROOT;
const SCRIPTS_DEST       = join(API_ROOT, 'bundled-scripts');
const OUTPUT_DIR         = join(API_ROOT, 'dist');
const OUTPUT_EXE         = join(OUTPUT_DIR, 'IdentityAtlas.exe');

const skipUiBuild = process.argv.includes('--skip-ui-build');

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: cwd || API_ROOT, stdio: 'inherit' });
}

// ─── Step 1: Build React UI ───────────────────────────────────────────────────
if (!skipUiBuild) {
  console.log('\n[1/4] Building React UI...');
  run('npm ci --prefer-offline', UI_ROOT);
  run('npm run build', UI_ROOT);
} else {
  console.log('\n[1/4] Skipping UI build (--skip-ui-build)');
}

if (!existsSync(FRONTEND_DIST_SRC)) {
  throw new Error(`UI build output not found at ${FRONTEND_DIST_SRC}. Run without --skip-ui-build.`);
}

// ─── Step 2: Copy frontend dist into api/ so pkg can bundle it as an asset ───
console.log('\n[2/4] Copying frontend dist...');
if (existsSync(FRONTEND_DIST_DEST)) {
  rmSync(FRONTEND_DIST_DEST, { recursive: true, force: true });
}
cpSync(FRONTEND_DIST_SRC, FRONTEND_DIST_DEST, { recursive: true });
console.log(`  → ${FRONTEND_DIST_DEST}`);

// ─── Step 3: Copy PowerShell scripts into api/ for bundling ──────────────────
// Bundled layout mirrors the Docker container's /app/ layout so IA_APP_ROOT
// points to the same relative structure that scheduler.ps1 expects.
console.log('\n[3/4] Copying PowerShell scripts...');
if (existsSync(SCRIPTS_DEST)) {
  rmSync(SCRIPTS_DEST, { recursive: true, force: true });
}

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

// ─── Step 4: Run pkg ─────────────────────────────────────────────────────────
console.log('\n[4/4] Running @yao-pkg/pkg...');
mkdirSync(OUTPUT_DIR, { recursive: true });
run(
  `npx @yao-pkg/pkg src/desktop.js ` +
  `--target node20-win-x64 ` +
  `--output ${OUTPUT_EXE} ` +
  `--compress GZip`
);

console.log(`\n✓ Build complete: ${OUTPUT_EXE}`);
