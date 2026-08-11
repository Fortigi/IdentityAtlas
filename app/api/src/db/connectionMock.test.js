// Tests for the shared DB manual mock (src/db/__mocks__/connection.js) plus a
// ratchet that keeps the route tests on it.
//
// The mock replaced ~10 lines of `vi.mock('../db/connection.js', () => ({...}))`
// boilerplate that had been copied into every route test (13 jscpd clone pairs).
// Two things have to stay true for that consolidation to hold:
//   1. The mock really exports the whole connection.js surface, and `tx` /
//      `getPool` route back through the exported `query` spy — otherwise a
//      converted test would silently stop staging transaction queries.
//   2. Nobody re-adds an inline factory. The remaining inline mocks live in
//      files with different mock shapes (out of scope for #665), so this is a
//      RATCHET, not a ban: the count may only go down.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import * as connection from './connection.js';
import { query, queryOne, tx, getPool, closePool, default as db } from './__mocks__/connection.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// The 14 route tests converted to the manual mock in #665. None of them may
// carry an inline factory again.
const CONVERTED = [
  'accountLinking.coverage', 'admin.coverage', 'authRoles.coverage', 'bulkLists.coverage',
  'contextPlugins.coverage', 'contextPlugins', 'contexts.coverage', 'orgChart.coverage',
  'recentChanges.routes', 'riskProfiles.coverage', 'riskProfiles', 'riskScoringRuns.coverage',
  'tags.coverage', 'tags',
].map(n => join(SRC, 'routes', `${n}.test.js`));

// Committed floor — the inline `vi.mock('../db/connection.js', () => ({...}))`
// factories still present after the #665 conversion. Lower it when you convert
// more files; never raise it.
const INLINE_FACTORY_BASELINE = 61;
const INLINE_FACTORY = /vi\.mock\(\s*['"][^'"]*db\/connection\.js['"]\s*,/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.test.js')) out.push(p);
  }
  return out;
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('db manual mock — surface', () => {
  it('covers every export of the real connection.js', () => {
    const real = Object.keys(connection).filter(k => k !== 'default');
    for (const name of real) {
      expect(db, `${name} missing from the manual mock`).toHaveProperty(name);
    }
    expect(real.sort()).toEqual(['closePool', 'getPool', 'query', 'queryOne', 'tx']);
  });

  it('exposes query/queryOne as resettable spies', async () => {
    query.mockResolvedValueOnce({ rows: [{ a: 1 }] });
    queryOne.mockResolvedValueOnce({ b: 2 });
    expect(await query('SELECT 1')).toEqual({ rows: [{ a: 1 }] });
    expect(await queryOne('SELECT 1')).toEqual({ b: 2 });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });
});

describe('db manual mock — tx / getPool forwarding', () => {
  it('tx hands the callback a client whose query is the shared spy', async () => {
    query.mockResolvedValueOnce({ rows: ['staged'] });
    const result = await tx(client => client.query('UPDATE x', [1]));
    expect(result).toEqual({ rows: ['staged'] });
    expect(query).toHaveBeenCalledWith('UPDATE x', [1]);
  });

  it('getPool resolves a pool whose query is the shared spy', async () => {
    query.mockResolvedValueOnce({ rows: ['pooled'] });
    const pool = await getPool();
    expect(await pool.query('SELECT 2')).toEqual({ rows: ['pooled'] });
    expect(query).toHaveBeenCalledWith('SELECT 2');
  });

  it('closePool resolves without touching the query spy', async () => {
    await expect(closePool()).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('the default export shares the same spies as the named exports', () => {
    expect(db.query).toBe(query);
    expect(db.queryOne).toBe(queryOne);
    expect(db.tx).toBe(tx);
    expect(db.getPool).toBe(getPool);
    expect(db.closePool).toBe(closePool);
  });
});

describe('db manual mock — adoption ratchet', () => {
  it('no converted route test re-adds an inline mock factory', () => {
    const offenders = CONVERTED.filter(f => INLINE_FACTORY.test(readFileSync(f, 'utf8')));
    expect(offenders.map(f => relative(SRC, f))).toEqual([]);
  });

  it('every converted route test uses the factory-less vi.mock', () => {
    const missing = CONVERTED.filter(f => !/vi\.mock\('\.\.\/db\/connection\.js'\)/.test(readFileSync(f, 'utf8')));
    expect(missing.map(f => relative(SRC, f))).toEqual([]);
  });

  it('the number of inline db-mock factories never rises', () => {
    const inline = walk(SRC).filter(f => INLINE_FACTORY.test(readFileSync(f, 'utf8')));
    expect(inline.length).toBeLessThanOrEqual(INLINE_FACTORY_BASELINE);
  });
});
