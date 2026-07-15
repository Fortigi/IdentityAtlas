// Hard guard: the API talks to Postgres through ONE native surface.
//
// #663 removed the MSSQL compatibility shim — `getPool().request().input(name,
// val).query()` returning `{ recordset }`, with `@name` placeholders rewritten
// to `$N`. Every query is now native pg (`db.query` / `timedQuery` /
// `pool.query`) with positional `$N` params, reading `.rows`. This static scan
// fails the build if the shim — or a second, ungoverned pg pool — creeps back.
//
//   Tier 1 — no shim / T-SQL surface in production code: timedRequest,
//     makeCompatRequest, replaceAtParams, splitSqlStatements, `.request(`,
//     `.input(`, `.recordset(s)`, `.rowsAffected`, and `@name` SQL params.
//   Tier 2 — only db/connection.js (and the standalone auth CLI) may import
//     `pg` or construct a Pool, so the pool stays a single governed surface.
//
// Test files are deliberately NOT scanned: a few legitimately mock the old
// `{ recordset }` shape to prove native callers still read it during the
// transition. Comment lines are skipped so the JSDoc `@param`/`@returns` tags
// and this file's own explanatory prose don't trip the scan.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const rel = (f) => relative(SRC, f).replace(/\\/g, '/');

// Skip single-line and block-comment lines — the ban is about live code, not the
// prose that documents the migration away from the shim.
const isComment = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

function scan(re, { allow = new Set() } = {}) {
  const offenders = [];
  for (const f of FILES) {
    if (allow.has(rel(f))) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!isComment(line) && re.test(line)) offenders.push(`${rel(f)}:${i + 1}  ${line.trim()}`);
    });
  }
  return offenders;
}

describe('native-pg guard — no MSSQL shim / T-SQL surface (Tier 1)', () => {
  const BANNED = [
    { name: 'timedRequest',       re: /\btimedRequest\b/ },
    { name: 'makeCompatRequest',  re: /\bmakeCompatRequest\b/ },
    { name: 'replaceAtParams',    re: /\breplaceAtParams\b/ },
    { name: 'splitSqlStatements', re: /\bsplitSqlStatements\b/ },
    { name: '.recordset(s)',      re: /\.recordsets?\b/ },
    { name: '.rowsAffected',      re: /\.rowsAffected\b/ },
    { name: '.request(',          re: /\.request\(/ },
    { name: '.input(',            re: /\.input\(/ },
  ];

  for (const { name, re } of BANNED) {
    it(`no production file uses the shim surface: ${name}`, () => {
      const offenders = scan(re);
      expect(offenders, `${name} reintroduced:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('no production SQL uses a T-SQL @name placeholder', () => {
    // A T-SQL param is `@word` preceded by `=`, `(`, `,`, or whitespace, inside a
    // SQL string. Comment lines (JSDoc @param/@returns, @asof design notes) skip.
    const offenders = scan(/[=(,\s]@[A-Za-z_]\w*/);
    expect(offenders, `T-SQL @name param reintroduced:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('single pg surface — only connection.js owns the pool (Tier 2)', () => {
  // db/connection.js is the one governed pool. cli/auth-config.js is a standalone
  // short-lived process (invoked via `docker exec`) that cannot share it.
  const ALLOW = new Set(['db/connection.js', 'cli/auth-config.js']);

  it('no other file imports pg or constructs a Pool', () => {
    const offenders = scan(/\bnew Pool\b|from ['"]pg['"]|require\(['"]pg['"]\)/, { allow: ALLOW });
    expect(offenders, `pg/Pool used outside the governed surface:\n${offenders.join('\n')}`).toEqual([]);
  });
});
