// Hard-rule guard for the report engine.
//
// The epic's Key Result is that adding a third report costs only a template. It
// holds exactly as long as no engine file knows a report by name: the moment a
// route, the registry, or a UI renderer says `if (name === 'orphaned-accounts')`,
// the next report needs an engine change and the seam has moved to the wrong
// place. Same shape as ingest/assignmentTypes.guard.test.js — a static scan of
// the places the rule could be broken, so it can't be broken quietly.
//
// The two exempt spots are the templates themselves (a template naming itself
// is the point) and templates/index.js (the ONE registration line).
//
// Paired with the live seam test in routes/reports.test.js: this one proves no
// engine file names a report, that one proves an unknown template still works.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { listReports } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..', '..', '..');           // app/
const TEMPLATES_DIR = join(__dirname, 'templates');

// Every report name the engine must stay ignorant of: the registered templates
// plus every template file on disk (so a template that isn't wired up yet still
// can't be special-cased). Derived, never hand-listed.
const templateFileNames = readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.js') && f !== 'index.js' && !f.includes('.test.'))
  .map(f => f.replace(/\.js$/, ''));
const REPORT_NAMES = [...new Set([...listReports().map(r => r.name), ...templateFileNames])];

// The engine: everything that must work for ANY template. `src/reports/` minus
// `templates/`, the API routes, and the generic UI report surfaces.
function filesIn(dir) {
  return readdirSync(dir)
    .map(name => join(dir, name))
    .filter(p => statSync(p).isFile() && /\.(js|jsx)$/.test(p) && !/\.test\.|\.guard\./.test(p));
}

const ENGINE_FILES = [
  ...filesIn(__dirname),                                       // registry.js, types.js
  join(__dirname, '..', 'routes', 'reports.js'),
  join(appRoot, 'ui', 'src', 'components', 'ReportsPage.jsx'),
  ...filesIn(join(appRoot, 'ui', 'src', 'components', 'reports')),
];

describe('report engine — no template names in engine code', () => {
  it('has report names to guard against and engine files to scan', () => {
    // A guard that scans nothing passes silently; assert it has real work.
    expect(REPORT_NAMES.length).toBeGreaterThan(0);
    expect(ENGINE_FILES.length).toBeGreaterThanOrEqual(5);
    for (const f of ENGINE_FILES) expect(statSync(f).isFile(), f).toBe(true);
  });

  it('no engine file mentions a report by name', () => {
    const offenders = [];
    for (const file of ENGINE_FILES) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const name of REPORT_NAMES) {
          if (line.includes(name)) offenders.push(`${relative(appRoot, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `engine file(s) name a specific report — the next report would need an engine change.\n` +
      `Move the report-specific behaviour into its template (or into a new declared form):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('registers each template from exactly one line in templates/index.js', () => {
    // The registration line is the one place a name may appear outside a
    // template. Keeping it to an import means adding a report can't grow into
    // "and configure it here too".
    const index = readFileSync(join(TEMPLATES_DIR, 'index.js'), 'utf8').split('\n');
    for (const name of templateFileNames) {
      const mentions = index.filter(l => l.includes(name));
      expect(mentions, `${name} in templates/index.js`).toHaveLength(1);
      expect(mentions[0]).toMatch(new RegExp(`^import .* from '\\./${name}\\.js';$`));
    }
  });
});
