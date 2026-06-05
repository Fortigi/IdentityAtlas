// Postgres LIKE-case-sensitivity audit.
//
// Three case-sensitivity bugs landed on this codebase in 2026 (assign-by-filter,
// /groups-with-nested, /group/:id/nested-groups). All three were SQL-Server-era
// code where `LIKE` was case-insensitive by default. PostgreSQL's `LIKE` is
// case-sensitive, so filters like `principalType LIKE '%group%'` silently
// matched zero rows (the data stores 'Group' with a capital G).
//
// This test scans the route handlers for the pattern. If a future change
// reintroduces `LIKE` on a column where we historically relied on case-
// insensitivity, the test fails loudly. The fix is one keystroke:
// `LIKE` → `ILIKE`.
//
// Columns audited here are the ones we've actually been bitten on. Add more
// to AUDITED_COLUMNS if a new case-sensitivity miss surfaces.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = __dirname;

// Columns where SQL Server's default-case-insensitive `LIKE` was load-bearing.
// `LIKE` on these in postgres is almost always a bug.
const AUDITED_COLUMNS = [
  'principalType',
  'displayName',
  'email',
  'description',
  'userPrincipalName',
  'resourceType',
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) continue;
    if (entry.endsWith('.test.js')) continue;
    if (!entry.endsWith('.js')) continue;
    out.push(p);
  }
  return out;
}

describe('postgres LIKE case-sensitivity audit', () => {
  const files = listJsFiles(ROUTES_DIR);

  for (const col of AUDITED_COLUMNS) {
    it(`no plain LIKE on "${col}" in routes/* (use ILIKE)`, () => {
      const offenders = [];
      // Match quoted or unquoted column, optional alias prefix, then `LIKE`
      // (but NOT `ILIKE`). Word boundary on LIKE so it's not matching inside
      // ILIKE / DISLIKE / etc.
      // eslint-disable-next-line security/detect-non-literal-regexp -- col is an internal column name constant from test fixtures, not user input
      const pattern = new RegExp(
        // optional `alias.` then optional double-quoted column name
        `(?:[A-Za-z_]\\w*\\.)?(?:"${col}"|\\b${col}\\b)\\s+(?<!I)LIKE\\b`,
        'g'
      );
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        let m;
        while ((m = pattern.exec(content)) !== null) {
          const line = content.slice(0, m.index).split('\n').length;
          offenders.push(`${file}:${line}  ${m[0]}`);
        }
      }
      expect(
        offenders,
        `Found plain LIKE on "${col}" — use ILIKE instead (postgres LIKE is case-sensitive).\n  ` +
          offenders.join('\n  ')
      ).toEqual([]);
    });
  }
});
