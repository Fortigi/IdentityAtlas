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

// Every non-test .js file under `dir`, including sub-folders (routes/tags/,
// routes/contexts/, … hold most of the list endpoints).
function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__mocks__' && entry !== 'migrations') out.push(...listJsFiles(p));
      continue;
    }
    if (entry.endsWith('.test.js')) continue;
    if (!entry.endsWith('.js')) continue;
    out.push(p);
  }
  return out;
}

// ── LIKE-metacharacter escaping (SEC-2026-09 L-14) ──────────────────────────
// A bound LIKE/ILIKE pattern — `ILIKE ${s}`, `ILIKE $${params.length}`,
// `ILIKE $3` — must carry `ESCAPE '\'`, and the bound value must come from
// likeContains()/escapeLike() in db/sqlParams.js. A contains-pattern built by
// hand as a `%${…}%` template string skips the escaping.
const BOUND_LIKE_RE = /\bI?LIKE\s+(?:\$\$?\{[^}]*\}|\$\d+)(?!\s+ESCAPE\s+'\\\\')/g;
const RAW_CONTAINS_RE = /`%\$\{/g;

export function findUnescapedLike(content) {
  const hits = [];
  for (const re of [BOUND_LIKE_RE, RAW_CONTAINS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      hits.push({ line: content.slice(0, m.index).split('\n').length, text: m[0] });
    }
  }
  return hits;
}

describe('LIKE metacharacter escaping audit (SEC-2026-09 L-14)', () => {
  it('the detector flags an unescaped bound ILIKE and a hand-built %…% value', () => {
    const snippet = [
      'const s = bind(`%${search}%`);',
      'where += ` AND (a ILIKE ${s} OR b ILIKE ${s} ESCAPE \'\\\\\')`;',
      'where.push(`x LIKE $${params.length}`);',
      'sql = `y ILIKE $2`;',
    ].join('\n');
    expect(findUnescapedLike(snippet).map((h) => h.line)).toEqual([2, 3, 4, 1]);
  });

  it('the detector accepts the escaped form', () => {
    expect(findUnescapedLike('where += ` AND a ILIKE ${s} ESCAPE \'\\\\\'`; bind(likeContains(q));')).toEqual([]);
  });

  it('no unescaped user-search LIKE anywhere in src/', () => {
    const offenders = [];
    for (const file of listJsFiles(join(ROUTES_DIR, '..'))) {
      for (const h of findUnescapedLike(readFileSync(file, 'utf-8'))) {
        offenders.push(`${file}:${h.line}  ${h.text}`);
      }
    }
    expect(
      offenders,
      'Bound LIKE/ILIKE without ESCAPE, or a hand-built %…% pattern — bind likeContains(value) ' +
        "from db/sqlParams.js and add ESCAPE '\\\\' to the comparison.\n  " + offenders.join('\n  '),
    ).toEqual([]);
  });
});

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
