// contextType values the application code branches on.
//
// contextType is an open vocabulary: a crawler or an analyst may store any
// string. The values the CODE itself relies on are not open, though — a route
// that filters `"contextType" = 'Tag'` or a screen that checks
// `contextType === 'ManagerHierarchy'` gives that value a meaning, and the
// ontology must define it. Those comparisons are inline literals (mostly inside
// SQL), so they are found by scanning the source, the same way
// ingest/assignmentTypes.guard.test.js scans the crawlers. Plugins declare what
// they emit in their `contextTypes` field instead (contexts/plugins/types.js).

import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Source trees whose comparisons count, relative to the repository root. */
export const SCANNED_DIRS = ['app/api/src', 'app/ui/src'];

// A type value starts with a capital: that keeps `typeof x.contextType !== 'string'` out.
const PATTERNS = [
  /"contextType"\s*(?:=|<>|!=)\s*'([A-Z][A-Za-z]*)'/g, // SQL
  /\bcontextType\s*(?:===|!==|==|!=)\s*'([A-Z][A-Za-z]*)'/g, // JavaScript
];

const SOURCE_FILE = /\.(?:js|jsx|mjs)$/;
const SKIPPED = /(?:\.test\.|\.spec\.|__tests__|node_modules|[\\/]dist[\\/])/;

/** The contextType literals one source text compares against, with line numbers. */
export function contextTypeLiterals(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const re of PATTERNS) {
      for (const m of line.matchAll(re)) out.push({ value: m[1], line: i + 1 });
    }
  });
  return out;
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIPPED.test(full)) continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_FILE.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every contextType value the scanned code compares against, mapped to where
 * (`path:line`, repository-relative).
 * @returns {Map<string, string[]>}
 */
export function scanContextTypeUsage(root = ROOT, dirs = SCANNED_DIRS) {
  const usage = new Map();
  for (const dir of dirs) {
    for (const file of sourceFiles(join(root, dir))) {
      const rel = relative(root, file).replace(/\\/g, '/');
      for (const { value, line } of contextTypeLiterals(readFileSync(file, 'utf8'))) {
        if (!usage.has(value)) usage.set(value, []);
        usage.get(value).push(`${rel}:${line}`);
      }
    }
  }
  return usage;
}
