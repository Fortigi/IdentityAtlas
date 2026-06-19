// Enforces that no source file in src/ uses relative path traversal ('../')
// for cross-directory imports, and that no wizard/summary file in
// tools/crawlers/ imports from app/ui/src/ via '../../../' chains.
// Use '@ui/' instead — see app/ui/CLAUDE.md → Import path aliases.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const uiRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');  // app/ui/
const srcRoot = path.join(uiRoot, 'src');
const crawlerRoot = path.resolve(uiRoot, '../../tools/crawlers');

function walkFiles(dir, ext, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      walkFiles(full, ext, files);
    } else if (entry.isFile() && ext.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const IMPORT_RE = /^\s*import\s+.+\s+from\s+'(\.\.[^']+)'/gm;

describe('import-conventions', () => {
  it('src/ files use @ui/ alias — no relative traversal (../)', () => {
    const srcFiles = walkFiles(srcRoot, /\.(js|jsx)$/).filter(
      f => !f.includes('__tests__') && !f.includes('.test.')
    );
    const violations = [];
    for (const file of srcFiles) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_RE)) {
        violations.push(`${path.relative(uiRoot, file)}: ${m[0].trim()}`);
      }
    }
    expect(violations, 'Relative traversal imports found — use @ui/ alias instead').toEqual([]);
  });

  it('tools/crawlers/ wizard files use @ui/ alias — no ../../../app/ traversal', () => {
    const crawlerFiles = walkFiles(crawlerRoot, /\.(js|jsx)$/);
    const violations = [];
    const APP_PATH_RE = /app[\\/]ui[\\/]src|app[\\/]api[\\/]src/;
    for (const file of crawlerFiles) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_RE)) {
        if (APP_PATH_RE.test(m[1])) {
          violations.push(`${path.relative(crawlerRoot, file)}: ${m[0].trim()}`);
        }
      }
    }
    expect(violations, 'Cross-package traversal in crawlers — use @ui/ or @api/ alias instead').toEqual([]);
  });
});
