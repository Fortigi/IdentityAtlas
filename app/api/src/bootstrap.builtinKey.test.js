// Built-in worker key handling (security finding H-02).
//
// Invariant under test: the worker's API key is NEVER persisted in plaintext in
// the database. It lives only in the scrypt hash (Crawlers) + the 0600 volume
// file. We drive ensureBuiltinCrawler() with a mocked DB and a real temp key
// file and assert no WorkerConfig plaintext write happens on any path, plus the
// create / reuse / rotate / legacy-upgrade behaviours.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must be set before importing bootstrap.js (it captures WORKER_KEY_FILE at load).
const KEY_FILE = join(tmpdir(), `iatest-worker-key-${process.pid}`);
process.env.WORKER_KEY_FILE = KEY_FILE;

const queryOneMock = vi.fn();
const queryMock = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock('./db/connection.js', () => ({
  query: (...a) => queryMock(...a),
  queryOne: (...a) => queryOneMock(...a),
  getPool: async () => ({ query: async () => ({ rows: [] }) }),
  closePool: async () => {},
  tx: async (fn) => fn({ query: async () => ({ rows: [] }) }),
}));

const { ensureBuiltinCrawler } = await import('./bootstrap.js');

// Must match hashKey() in bootstrap.js exactly.
const scrypt = (key, salt) => crypto.scryptSync(key, salt, 64, { N: 16384, r: 8, p: 1 });

const sqlCalls = (re) => queryMock.mock.calls.filter(([sql]) => re.test(String(sql)));
const workerConfigPlaintextWrites = () =>
  queryMock.mock.calls.filter(([sql]) => /INSERT\s+INTO\s+"WorkerConfig"/i.test(String(sql)) && /BUILTIN_CRAWLER_API_KEY/i.test(String(sql)));

beforeEach(() => {
  queryOneMock.mockReset();
  queryMock.mockClear();
  try { rmSync(KEY_FILE); } catch { /* not present */ }
});

describe('ensureBuiltinCrawler — never stores the key in plaintext (H-02)', () => {
  it('fresh install: creates the crawler + writes only the 0600 file', async () => {
    queryOneMock.mockResolvedValue(null); // no existing crawler
    await ensureBuiltinCrawler();

    expect(sqlCalls(/INSERT\s+INTO\s+"Crawlers"/i).length).toBe(1);
    expect(existsSync(KEY_FILE)).toBe(true);
    expect(readFileSync(KEY_FILE, 'utf8')).toMatch(/^fgc_/);
    expect(workerConfigPlaintextWrites()).toEqual([]);                 // <-- never plaintext
    expect(sqlCalls(/DELETE\s+FROM\s+"WorkerConfig"/i).length).toBe(1); // legacy row scrubbed
  });

  it('reuses the key when the volume file still matches the stored hash', async () => {
    const key = 'fgc_' + 'a'.repeat(64);
    const salt = crypto.randomBytes(32);
    writeFileSync(KEY_FILE, key);
    queryOneMock.mockResolvedValue({ id: 1, apiKeyHash: scrypt(key, salt), apiKeySalt: salt });

    await ensureBuiltinCrawler();

    expect(sqlCalls(/UPDATE\s+"Crawlers"/i)).toEqual([]); // no rotation
    expect(sqlCalls(/INSERT\s+INTO\s+"Crawlers"/i)).toEqual([]);
    expect(readFileSync(KEY_FILE, 'utf8')).toBe(key);     // unchanged
    expect(workerConfigPlaintextWrites()).toEqual([]);
  });

  it('rotates when the volume file is missing — still no plaintext in the DB', async () => {
    const salt = crypto.randomBytes(32);
    queryOneMock.mockResolvedValue({ id: 1, apiKeyHash: scrypt('fgc_stale', salt), apiKeySalt: salt });
    // KEY_FILE absent (removed in beforeEach)

    await ensureBuiltinCrawler();

    expect(sqlCalls(/UPDATE\s+"Crawlers"/i).length).toBe(1); // rotated
    expect(existsSync(KEY_FILE)).toBe(true);
    expect(readFileSync(KEY_FILE, 'utf8')).toMatch(/^fgc_/);
    expect(workerConfigPlaintextWrites()).toEqual([]);
  });

  it('upgrades a legacy 32-byte SHA-256 hash to scrypt (rotates, no plaintext)', async () => {
    queryOneMock.mockResolvedValue({ id: 1, apiKeyHash: crypto.randomBytes(32), apiKeySalt: null });

    await ensureBuiltinCrawler();

    expect(sqlCalls(/UPDATE\s+"Crawlers"/i).length).toBe(1);
    expect(workerConfigPlaintextWrites()).toEqual([]);
  });
});
