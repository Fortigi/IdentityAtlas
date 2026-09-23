// The conversation store, as both surfaces use it.
//
// Most of what 069 established is still pinned by teamsbot/log.test.js through
// the re-export. What is tested here is what 071 added: the columns an
// evaluation reads, the two-request completion the web needs, and the reads a
// history sidebar makes — every one of them scoped to the caller who asked.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  logConversation, completeRun, listConversations, getConversation, OUTCOMES, SURFACES,
} from './conversations.js';

const ID = '11111111-1111-1111-1111-111111111111';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const entry = (over = {}) => ({
  id: ID, callerOid: OID, callerPrincipalId: null, conversationId: 'conv-1',
  question: 'welke groepen heb ik die william niet heeft?', language: 'nl',
  definition: { entity: 'user', conditions: [] }, outcome: OUTCOMES.INTERPRETED,
  modelMs: 66_400, totalMs: 66_900, ...over,
});

/** The INSERT's parameter array, keyed by the column names in the SQL. */
function inserted(q) {
  const [sql, values] = q.mock.calls[0];
  const names = sql.match(/\(([^)]*)\)\s*VALUES/s)[1].match(/"(\w+)"/g).map(s => s.replace(/"/g, ''));
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
}

describe('what 071 added to a logged question', () => {
  it('records which surface asked, and defaults to the bot for every caller that predates the column', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry({ surface: SURFACES.WEB }), q);
    expect(inserted(q).surface).toBe('web');

    const q2 = vi.fn(async () => ({}));
    await logConversation(entry(), q2);
    expect(inserted(q2).surface).toBe('teams');
  });

  it('keeps the context and the raw reply with their line breaks — they are prompt text, not log lines', async () => {
    // The question is flattened because it is mirrored to the container log,
    // where a line break forges a second entry. These two are not mirrored and
    // are read back as what the model saw and said.
    const q = vi.fn(async () => ({}));
    await logConversation(entry({
      context: 'The person asking is Wim.\n\nRequest: welke groepen',
      rawReply: '{"kind":"report",\n"spec":{}}',
    }), q);
    const p = inserted(q);
    expect(p.context).toContain('\n');
    expect(p.rawReply).toContain('\n');
  });

  it('caps the context and the reply rather than writing them whole', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry({ context: 'x'.repeat(50_000), rawReply: 'y'.repeat(50_000) }), q);
    const p = inserted(q);
    expect(p.context.length).toBeLessThan(50_000);
    expect(p.rawReply.length).toBeLessThan(50_000);
  });

  it('stores repaired only as a real boolean, and the model name', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry({ repaired: true, model: 'qwen3:4b' }), q);
    expect(inserted(q).repaired).toBe(true);
    expect(inserted(q).model).toBe('qwen3:4b');

    const q2 = vi.fn(async () => ({}));
    await logConversation(entry({ repaired: 'yes' }), q2);
    // A truthy non-boolean is not "it was repaired"; it is a bug upstream,
    // and null keeps it out of the count instead of adding to it.
    expect(inserted(q2).repaired).toBe(null);
  });

  it('writes nulls for the new columns when a caller does not know them', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry(), q);
    const p = inserted(q);
    expect(p.context).toBe(null);
    expect(p.rawReply).toBe(null);
    expect(p.repaired).toBe(null);
    expect(p.model).toBe(null);
  });
});

describe('every outcome the code can write is one the database accepts', () => {
  // The insert is best-effort: a misspelt outcome would not throw, it would
  // silently drop the row. So the names in code and the CHECK constraint in
  // the migration are held to be the same set, here.
  const migration = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '071_conversation_store.sql'), 'utf8',
  );
  const allowed = migration
    .match(/ck_BotConversations_outcome"\s*CHECK \("outcome" IN \(([^)]*)\)\)/s)[1]
    .match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));

  it('matches the constraint exactly, in both directions', () => {
    expect(new Set(Object.values(OUTCOMES))).toEqual(new Set(allowed));
  });

  it('has an outcome for a definition that is waiting to be run, and for a name that needs confirming', () => {
    expect(allowed).toContain('interpreted');
    expect(allowed).toContain('confirm');
  });
});

describe('completing a run', () => {
  const done = { id: ID, callerOid: OID, definition: { entity: 'user', conditions: [] }, rowCount: 3, columns: ['displayName'], truncated: false, queryMs: 24 };

  it('fills in the result and reports that it did', async () => {
    const q = vi.fn(async () => ({ rowCount: 1 }));
    expect(await completeRun(done, q)).toBe(true);
    const [sql, values] = q.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE "BotConversations"/);
    expect(values).toContain(3);
    expect(values).toContain(24);
  });

  it('only completes the row that is still waiting, for this caller, for THIS definition', async () => {
    // The three guards, visible in the SQL. Without the definition guard an
    // edited-and-rerun report would be recorded as the answer to the original
    // question; without the outcome guard a second run would overwrite the
    // first result.
    const q = vi.fn(async () => ({ rowCount: 1 }));
    await completeRun(done, q);
    const [sql, values] = q.mock.calls[0];
    expect(sql).toContain('"callerOid" IS NOT DISTINCT FROM');
    expect(sql).toContain('"definition" = $3::jsonb');
    expect(sql).toContain('"outcome" = $9');
    expect(values[8]).toBe(OUTCOMES.INTERPRETED);
    expect(values[3]).toBe(OUTCOMES.ANSWERED);
  });

  it('compares the definition as JSON, so key order cannot make it a different report', async () => {
    const q = vi.fn(async () => ({ rowCount: 1 }));
    await completeRun(done, q);
    expect(JSON.parse(q.mock.calls[0][1][2])).toEqual(done.definition);
  });

  it('reports false when nothing matched, and when the write failed', async () => {
    expect(await completeRun(done, vi.fn(async () => ({ rowCount: 0 })))).toBe(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await completeRun(done, vi.fn(async () => { throw new Error('boom'); }))).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it('matches a caller without an id to a row without one — the auth-off case', async () => {
    // IS NOT DISTINCT FROM is what makes null = null here; a plain = would
    // never complete a row on a deployment that runs without authentication.
    const q = vi.fn(async () => ({ rowCount: 1 }));
    await completeRun({ ...done, callerOid: undefined }, q);
    expect(q.mock.calls[0][1][1]).toBe(null);
  });
});

describe('a history sidebar reads', () => {
  it('lists nothing for a caller without an id, without asking the database', async () => {
    // With auth off there is no owner to scope to. Everyone's questions is
    // not a history, it is a leak.
    const q = vi.fn();
    expect(await listConversations(null, {}, q)).toEqual([]);
    expect(await getConversation(null, 'conv-1', q)).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });

  it('lists this caller’s web conversations, newest first, one line each', async () => {
    const q = vi.fn(async () => ({ rows: [{ conversationId: 'conv-1', turns: 2, firstQuestion: 'q' }] }));
    const out = await listConversations(OID, { limit: 10 }, q);
    const [sql, values] = q.mock.calls[0];
    expect(sql).toContain('"callerOid" = $1');
    expect(sql).toContain('GROUP BY "conversationId"');
    expect(sql).toMatch(/ORDER BY max\("createdAt"\) DESC/);
    expect(values).toEqual([OID, 'web', 10]);
    expect(out).toHaveLength(1);
  });

  it('clamps an absurd limit rather than passing it through', async () => {
    const q = vi.fn(async () => ({ rows: [] }));
    await listConversations(OID, { limit: 100_000 }, q);
    expect(q.mock.calls[0][1][2]).toBe(200);
    await listConversations(OID, { limit: -5 }, q);
    expect(q.mock.calls[1][1][2]).toBe(1);
  });

  it('returns the turns of one conversation in order, with the raw reply that lets it resume', async () => {
    const q = vi.fn(async () => ({ rows: [{ id: ID, question: 'q', rawReply: '{}' }] }));
    const out = await getConversation(OID, 'conv-1', q);
    const [sql, values] = q.mock.calls[0];
    expect(sql).toContain('"callerOid" = $1 AND "conversationId" = $2');
    expect(sql).toContain('"rawReply"');
    expect(sql).toMatch(/ORDER BY "createdAt" ASC/);
    expect(values).toEqual([OID, 'conv-1']);
    expect(out[0].rawReply).toBe('{}');
  });

  it('never returns undefined for an empty result', async () => {
    const q = vi.fn(async () => ({}));
    expect(await listConversations(OID, {}, q)).toEqual([]);
    expect(await getConversation(OID, 'conv-1', q)).toEqual([]);
  });
});
