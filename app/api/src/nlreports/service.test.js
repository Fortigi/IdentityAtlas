import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
// The whole module surface: settings.js imports MODEL_IS_FIXED from here as well.
vi.mock('./llm.js', () => ({ chat: vi.fn(), warm: vi.fn(), DEFAULT_MODEL: 'test-model', MODEL_IS_FIXED: false }));

import { query, tx } from '../db/connection.js';
import { chat, warm } from './llm.js';
import { buildSystemPrompt, REPORT_ONLY_SCHEMA, RESPONSE_SCHEMA } from './prompt.js';
import { ensureWarm, hasAnyMatch, interpret, needsOrRepair, runSpec, schemaFor, warmAtStartup, warmupState } from './service.js';
import { clearExtFieldsCache } from './extFields.js';

describe('warm-up at API start', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('does nothing on an install that did not switch custom reports on, even with a server URL', async () => {
    process.env.NL_REPORTS_LLM_URL = 'http://report-generator:8080';
    process.env.FEATURE_CUSTOM_REPORTS = 'false';
    expect(await warmAtStartup({ delayMs: 0 })).toBe('skipped');
    expect(warm).not.toHaveBeenCalled();
  });

  it('does nothing when no model server is configured, even with the feature on', async () => {
    delete process.env.NL_REPORTS_LLM_URL;
    process.env.FEATURE_CUSTOM_REPORTS = 'true';
    expect(await warmAtStartup({ delayMs: 0 })).toBe('skipped');
    expect(warm).not.toHaveBeenCalled();
  });

  it('retries a server that is still starting, and stops once it answers', async () => {
    process.env.NL_REPORTS_LLM_URL = 'http://report-generator:8080';
    process.env.FEATURE_CUSTOM_REPORTS = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warm.mockRejectedValueOnce(new Error('ENOTFOUND')).mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await warmAtStartup({ attempts: 3, delayMs: 0 })).toBe('ready');
    expect(warm).toHaveBeenCalledTimes(3);
  });

  it('gives up after its attempts', async () => {
    process.env.NL_REPORTS_LLM_URL = 'http://report-generator:8080';
    process.env.FEATURE_CUSTOM_REPORTS = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    warm.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await warmAtStartup({ attempts: 2, delayMs: 0 })).toBe('failed');
    expect(warm).toHaveBeenCalledTimes(2);
  });
});

const AND_SPEC = { entity: 'user', match: 'all', conditions: [
  { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
  { type: 'relation', relation: 'manager', quantifier: 'none', match: 'all', conditions: [] },
  { type: 'relation', relation: 'manager', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'accountEnabled', op: 'eq', value: false }] },
] };
const OR_SPEC = { ...AND_SPEC, conditions: [AND_SPEC.conditions[0], { type: 'group', match: 'any', conditions: AND_SPEC.conditions.slice(1) }] };
const reply = (spec) => ({ content: JSON.stringify({ kind: 'report', assumptions: [], spec }), timing: { totalMs: 10, promptTokens: 1, promptMs: 1, outputTokens: 1, outputMs: 1, loadMs: 0 } });

beforeEach(() => {
  chat.mockReset();
  warm.mockReset();
  warm.mockResolvedValue({ model: 'test-model', ms: 5, restored: true });
  query.mockReset();
  query.mockResolvedValue({ rows: [{ v: 'Guest' }, { v: 'Member' }] });
});

describe('OR detection', () => {
  it('recognises an OR at top level, in a group and inside a relation — but not a one-item "any"', () => {
    expect(hasAnyMatch(OR_SPEC)).toBe(true);
    expect(hasAnyMatch({ ...AND_SPEC, match: 'any' })).toBe(true);
    expect(hasAnyMatch({ entity: 'user', match: 'all', conditions: [{ type: 'relation', match: 'any', conditions: [{}, {}] }] })).toBe(true);
    expect(hasAnyMatch({ entity: 'user', match: 'any', conditions: [AND_SPEC.conditions[0]] })).toBe(false);
    expect(hasAnyMatch(AND_SPEC)).toBe(false);
  });

  it('asks for a repair only when the words say "or"/"either" and the definition has no OR', () => {
    expect(needsOrRepair("guests that don't have a manager, or whose manager is disabled", AND_SPEC)).toBe(true);
    expect(needsOrRepair('either guests or disabled accounts', AND_SPEC)).toBe(true);
    expect(needsOrRepair("guests that don't have a manager, or whose manager is disabled", OR_SPEC)).toBe(false);
    expect(needsOrRepair('guests without a manager whose manager is disabled', AND_SPEC)).toBe(false);
    expect(needsOrRepair('groups with Orion or Order in the name', { entity: 'group', match: 'all', conditions: [AND_SPEC.conditions[0]] })).toBe(false);
  });
});

describe('schemaFor', () => {
  const clarify = { role: 'assistant', content: JSON.stringify({ kind: 'clarify', question: '?' }) };

  it('allows clarifying questions until two have been asked, then demands a report', () => {
    expect(schemaFor([])).toBe(RESPONSE_SCHEMA);
    expect(schemaFor([clarify])).toBe(RESPONSE_SCHEMA);
    expect(schemaFor([clarify, { role: 'user', content: 'x' }, clarify])).toBe(REPORT_ONLY_SCHEMA);
  });

  it('counts only assistant turns that parse as a clarification', () => {
    const notClarify = [
      { role: 'user', content: clarify.content },
      { role: 'assistant', content: 'not json' },
      { role: 'assistant', content: JSON.stringify({ kind: 'report' }) },
    ];
    expect(schemaFor([clarify, ...notClarify])).toBe(RESPONSE_SCHEMA);
  });
});

describe('interpret — a definition still invalid after its repair round', () => {
  const BAD = { ...AND_SPEC, conditions: [AND_SPEC.conditions[0], { type: 'field', field: 'noSuchField', op: 'eq', value: 'x' }] };

  it('is reported as an error, not quietly answered without the condition it could not use', async () => {
    chat.mockResolvedValueOnce(reply(BAD)).mockResolvedValueOnce(reply(BAD));
    const r = await interpret({ question: 'guests with noSuchField x', model: 'm' });

    expect(chat).toHaveBeenCalledTimes(2);            // the repair round was tried
    expect(r.kind).toBe('error');
    expect(r.errors.join(' ')).toMatch(/noSuchField/);
    expect(r.spec).toBeUndefined();                   // nothing runnable is handed back
  });

  it('is answered normally when the repair round fixes it', async () => {
    chat.mockResolvedValueOnce(reply(BAD)).mockResolvedValueOnce(reply(AND_SPEC));
    const r = await interpret({ question: 'guests without a manager whose manager is disabled', model: 'm' });
    expect(r.kind).toBe('report');
    expect(r.repaired).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe('interpret — OR repair round', () => {
  it('replaces an AND definition with the corrected OR definition', async () => {
    chat.mockResolvedValueOnce(reply(AND_SPEC)).mockResolvedValueOnce(reply(OR_SPEC));
    const r = await interpret({ question: "Guest accounts that don't have a manager, or whose manager is disabled", model: 'm' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].messages.at(-1).content).toMatch(/says "or"/);
    expect(r.repaired).toBe(true);
    expect(r.spec.conditions[1]).toMatchObject({ type: 'group', match: 'any' });
    expect(r.timing.totalMs).toBe(20);
  });

  it('keeps the first definition when the correction still has no OR', async () => {
    chat.mockResolvedValueOnce(reply(AND_SPEC)).mockResolvedValueOnce(reply(AND_SPEC));
    const r = await interpret({ question: 'guests without a manager or with a disabled manager', model: 'm' });
    expect(r.spec.conditions).toHaveLength(3);
    expect(r.repaired).toBe(true);
  });

  it('does not spend a second call when there is no "or"', async () => {
    chat.mockResolvedValueOnce(reply(AND_SPEC));
    await interpret({ question: 'guests without a manager whose manager is disabled', model: 'm' });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('passes a clarification about missing data straight through', async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ kind: 'clarify', question: 'There is no last sign-in information. Which field holds it?', options: [] }), timing: {} });
    const r = await interpret({ question: 'users that have not signed in for 90 days', model: 'm' });
    expect(r).toMatchObject({ kind: 'clarify', question: expect.stringMatching(/sign-in/) });
  });
});

describe('deployment values travel with the question, not in the system prompt', () => {
  it('keeps the system prompt free of data and lists the values with the request', async () => {
    chat.mockResolvedValueOnce(reply(AND_SPEC));
    await interpret({ question: 'all guests', model: 'm' });
    const [system, user] = chat.mock.calls[0][0].messages;
    expect(system.content).toBe(buildSystemPrompt());
    expect(system.content).not.toMatch(/Guest \| Member/);
    expect(user.content).toMatch(/Values that exist in this deployment[\s\S]*Guest \| Member[\s\S]*Request: all guests/);
  });
});

describe('prompt-cache warm-up', () => {
  it('runs one warm-up at a time and reports its state', async () => {
    let release;
    warm.mockImplementationOnce(() => new Promise(r => { release = () => r({ model: 'test-model', ms: 200000, restored: false }); }));
    const first = ensureWarm();
    expect(ensureWarm()).toBe(first);   // a second caller joins the one in flight
    expect(warmupState()).toBe('warming');
    // The warm-up looks the model up first, so let those microtasks run.
    await vi.waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
    release();
    await expect(first.promise).resolves.toMatchObject({ restored: false });
    expect(warmupState()).toBe('ready');

    // An earlier success is not proof the model server still holds the prompt — it
    // restarts on its own — so the next caller checks again instead of assuming.
    const again = ensureWarm();
    expect(again).not.toBe(first);
    await again.promise;
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm.mock.calls[1]).toEqual(['test-model', buildSystemPrompt()]);
  });

  it('retries after a failed warm-up', async () => {
    warm.mockRejectedValueOnce(new Error('connection refused'));
    await expect(ensureWarm().promise).rejects.toThrow('connection refused');
    expect(warmupState()).toBe('failed');
    await expect(ensureWarm().promise).resolves.toMatchObject({ restored: true });
    expect(warmupState()).toBe('ready');
  });

  it('restores the prompt cache before a question, so a restarted server is not read cold', async () => {
    warm.mockClear();
    chat.mockResolvedValue(reply(OR_SPEC));
    await interpret({ question: 'all guests', model: 'm' });
    expect(warm).toHaveBeenCalledTimes(1);
    // The restore ran BEFORE the model was asked; the other way round it is useless.
    expect(warm.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]);
  });

  it('still answers when the prompt cache cannot be restored', async () => {
    warm.mockRejectedValueOnce(new Error('connection refused'));
    chat.mockResolvedValue(reply(OR_SPEC));
    const out = await interpret({ question: 'all guests', model: 'm' });
    expect(out.kind).toBe('report');
    expect(out.spec.entity).toBe('user');
  });
});

// ─── Running a definition, and the attributes a question names ───────

const RAW_LONG = 'extension_a1b2c3d4e5f60718293a4b5c6d7e8f90_sfBusinessUnitIdentifier';

// The discovery query is the one that reads the JSON keys; everything else in
// these tests is a value list. The keys are stamped on Principals only, the way a
// user attribute really is — which is why it turns up on user and account and
// nowhere else.
const withDiscovered = (...keys) => {
  query.mockImplementation(async (sql) => {
    if (!sql.includes('jsonb_object_keys')) return { rows: [{ v: 'Guest' }, { v: 'Member' }] };
    return { rows: (sql.includes('"Principals"') ? keys : []).map(key => ({ key })) };
  });
};

const returningRows = (rows) => {
  tx.mockImplementation(async (fn) => fn({ query: async () => ({ rows }) }));
};

describe('runSpec', () => {
  beforeEach(() => {
    clearExtFieldsCache();
    tx.mockReset();
    withDiscovered();
  });

  it('gives a grouped report rows of values and counts, with nothing to open', async () => {
    // Postgres hands back count(*) as a string; it must reach the UI as a number.
    returningRows([{ department: 'Finance', count: '42' }, { department: null, count: '7' }]);

    const result = await runSpec({ entity: 'user', groupBy: 'department' });

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ department: 'Finance', count: 42 }, { department: null, count: 7 }]);
    expect(result.columns).toEqual([{ key: 'department', label: 'Department' }, { key: 'count', label: 'Count' }]);
    expect(result.explanation.title).toBe('Users counted per department');
    expect(result.truncated).toBe(false);
  });

  it('still attaches the record to open on an ungrouped report', async () => {
    returningRows([{ __id: 'p1', displayName: 'Ada Lovelace' }]);

    const result = await runSpec({ entity: 'user', columns: ['displayName'] });

    expect(result.rows).toEqual([{ _entity: { kind: 'user', id: 'p1' }, displayName: 'Ada Lovelace' }]);
  });

  it('reads a column back under its own name even when Postgres was given a short alias', async () => {
    withDiscovered(RAW_LONG);
    // The SELECT aliases this one "c1" because its name is past 63 bytes.
    returningRows([{ __id: 'p1', displayName: 'Ada Lovelace', c1: 'BU-7' }]);

    const result = await runSpec({ entity: 'user', columns: ['displayName', `ext.${RAW_LONG}`] });

    expect(result.rows[0][`ext.${RAW_LONG}`]).toBe('BU-7');
    expect(result.sql).toContain('AS "c1"');
  });

  it('says so when the row limit cut the answer short', async () => {
    returningRows([{ department: 'A', count: '2' }, { department: 'B', count: '1' }]);
    const result = await runSpec({ entity: 'user', groupBy: 'department', limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('refuses a definition the validator rejects, without touching the database', async () => {
    const result = await runSpec({ entity: 'user', groupBy: 'createdDateTime' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('holds a date');
    expect(tx).not.toHaveBeenCalled();
  });
});

describe('interpret — attributes this deployment has', () => {
  beforeEach(() => {
    clearExtFieldsCache();
    withDiscovered('sfDepartmentID');
  });

  it('offers the named attribute to the model without putting it in the system prompt', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        kind: 'report', assumptions: [],
        spec: { entity: 'user', match: 'all', conditions: [], columns: [], groupBy: 'ext.sfDepartmentID' },
      }),
      timing: { totalMs: 10 },
    });

    const result = await interpret({ question: 'how many users per sfDepartmentID?', model: 'm' });

    expect(result.kind).toBe('report');
    expect(result.spec.groupBy).toBe('ext.sfDepartmentID');
    expect(result.sql).toContain(`GROUP BY t0."extendedAttributes"->>'sfDepartmentID'`);

    const { messages, schema } = chat.mock.calls[0][0];
    // Told with the question…
    expect(messages.at(-1).content).toContain('is the field ext.sfDepartmentID (on user and account)');
    // …and allowed by the grammar for this question…
    expect(JSON.stringify(schema)).toContain('ext.sfDepartmentID');
    // …but never in the system prompt, which is identical for every deployment
    // of a release and whose cache is prepared at build time.
    expect(messages[0].content).not.toContain('sfDepartmentID');
  });

  it('leaves the grammar and the request alone when the question names no attribute', async () => {
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ kind: 'report', assumptions: [], spec: { entity: 'user', match: 'all', conditions: [], columns: [] } }),
      timing: { totalMs: 10 },
    });

    await interpret({ question: 'how many users are there?', model: 'm' });

    const { messages, schema } = chat.mock.calls[0][0];
    expect(JSON.stringify(schema)).not.toContain('ext.');
    expect(messages.at(-1).content).not.toContain('Attributes from');
  });
});
