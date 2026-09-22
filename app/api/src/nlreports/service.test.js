import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
// The whole module surface: settings.js imports MODEL_IS_FIXED from here as well.
vi.mock('./llm.js', () => ({ chat: vi.fn(), warm: vi.fn(), DEFAULT_MODEL: 'test-model', MODEL_IS_FIXED: false }));

import { query, tx } from '../db/connection.js';
import { chat, warm } from './llm.js';
import { buildSystemPrompt, REPORT_ONLY_SCHEMA, RESPONSE_SCHEMA } from './prompt.js';
import {
  ensureWarm, hasAnyMatch, hasDisjunction, interpret, needsOrRepair, runSpec, schemaFor,
  warmAtStartup, warmupState,
} from './service.js';

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

describe('runSpec row shaping', () => {
  // A name-list column reads as one string ("ASML, AlisQI, Bestuur"), and the
  // ids behind those names now ride alongside it. Without them a chat card can
  // only link the whole run of names to the row's own record, and a follow-up
  // question about "these groups" has nothing to refer to.

  const SPEC = { entity: 'account', conditions: [], columns: ['displayName', 'owns.names'] };

  /** Run a spec against one fake result row. */
  const run = async (dbRow, spec = SPEC) => {
    query.mockResolvedValue({ rows: [] });
    tx.mockImplementation(async (fn) => fn({ query: async () => ({ rows: [dbRow] }) }));
    return runSpec(spec);
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it('hands back the records behind a name list, with the page each one opens', async () => {
    const out = await run({
      __id: 'u1',
      displayName: 'Wim',
      'owns.names': 'ASML, Bestuur',
      'owns.names__links': [{ id: 'g1', name: 'ASML' }, { id: 'g2', name: 'Bestuur' }],
    });

    expect(out.rows[0]._links['owns.names']).toEqual([
      { id: 'g1', name: 'ASML', kind: 'resource' },
      { id: 'g2', name: 'Bestuur', kind: 'resource' },
    ]);
  });

  it('leaves the readable cell exactly as it was', async () => {
    // The pairs are additive. If the visible value ever changes shape, exports
    // and the report table change with it.
    const out = await run({
      __id: 'u1',
      displayName: 'Wim',
      'owns.names': 'ASML, Bestuur',
      'owns.names__links': [{ id: 'g1', name: 'ASML' }, { id: 'g2', name: 'Bestuur' }],
    });

    expect(out.rows[0]['owns.names']).toBe('ASML, Bestuur');
    expect(out.rows[0].displayName).toBe('Wim');
    expect(out.rows[0]._entity).toEqual({ kind: 'user', id: 'u1' });
  });

  it('owns nothing: no _links key at all rather than an empty one', async () => {
    // jsonb_agg over no rows is NULL, not []. A row that carries `_links: {}`
    // reads as "has links" to every caller that tests for the key.
    const out = await run({ __id: 'u1', displayName: 'Wim', 'owns.names': null, 'owns.names__links': null });

    expect(out.rows[0]).not.toHaveProperty('_links');
    expect(out.rows[0]['owns.names']).toBe(null);
  });

  it('adds nothing to a report without a name list', async () => {
    const out = await run(
      { __id: 'u1', displayName: 'Wim', 'owns.count': 27 },
      { entity: 'account', conditions: [], columns: ['displayName', 'owns.count'] },
    );

    expect(out.rows[0]).not.toHaveProperty('_links');
    expect(out.rows[0]['owns.count']).toBe(27);
  });

  it('keeps the pairs out of the columns the caller is told about', async () => {
    // The companion is an implementation detail of the row, not a column
    // anybody should render — a table that shows it prints raw JSON.
    const out = await run({
      __id: 'u1', displayName: 'Wim', 'owns.names': 'ASML',
      'owns.names__links': [{ id: 'g1', name: 'ASML' }],
    });

    expect(out.columns.map(c => c.key)).toEqual(['displayName', 'owns.names']);
  });
});

describe('spotting alternatives in the question', () => {
  // The repair for "X or Y" built as "X AND Y" reads the QUESTION, and read it
  // in English only. This bot answers Dutch, where the word for "or" is also
  // the word for "whether" — and both senses turn up in one sentence often
  // enough that telling them apart is the whole job.

  it('reads the Dutch question that this was found on', () => {
    // "Kan je me vertellen OF William ... toegevoegd is OF uit groepen is weg
    // gehaald": the first is "whether", the second is "or". Missing it meant
    // the model's "Added AND Removed" was never sent back for repair.
    expect(hasDisjunction(
      'Kan je me vertellen of William in de laatste 180 dagen nog aan groepen toegevoegd is of uit groepen is weg gehaald?',
    )).toBe(true);
  });

  it.each([
    'Kan je me vertellen of er groepen zonder eigenaar zijn?',
    'Laat me zien of Jan nog actief is',
    'ik wil weten of dit klopt',
    'kun je controleren of deze groep leeg is',
  ])('does not read "whether" as "or" in: %s', (q) => {
    // Every one of these costs a wasted model call if it fires, and can turn a
    // correct AND into a wrong OR — so a miss is the cheaper mistake.
    expect(hasDisjunction(q)).toBe(false);
  });

  it.each([
    ['welke groepen heten Finance of HR', true],
    ['groepen met eigenaar Jan dan wel Piet', true],
    ['which groups are called Finance or HR', true],
    ['either Finance or HR', true],
    ['welke groepen hebben geen eigenaar', false],
    ['which groups have no owner', false],
  ])('reads %s as %s', (q, expected) => {
    expect(hasDisjunction(q)).toBe(expected);
  });

  it.each([
    'Can you give me a list of all guest accounts from the ACME?',
    'a list of the members of these groups',
    'the owner of each of the groups',
  ])('never reads the English preposition "of" as a disjunction: %s', (q) => {
    // The regression this gate exists for. "of" is one of the commonest words
    // in English, and reading it as "or" sent almost every English question to
    // a repair round that could turn a correct AND into a wrong OR. Dutch
    // markers must be present before the Dutch rule applies at all.
    expect(hasDisjunction(q)).toBe(false);
  });

  it('survives an empty or missing question', () => {
    expect(hasDisjunction('')).toBe(false);
    expect(hasDisjunction(null)).toBe(false);
    expect(hasDisjunction(undefined)).toBe(false);
  });

  it('does not fire on a word that merely contains "of"', () => {
    // "profiel", "software", "of" inside another word — the check is on whole
    // words, and this is what would break it if it were not.
    expect(hasDisjunction('welke accounts hebben een profiel in software')).toBe(false);
  });

  it('only asks for a repair when the definition actually has no OR', () => {
    const anded = { conditions: [{ type: 'field' }, { type: 'field' }], match: 'all' };
    const ored = { conditions: [{ type: 'field' }, { type: 'field' }], match: 'any' };
    const question = 'welke groepen heten Finance of HR';

    expect(needsOrRepair(question, anded)).toBe(true);
    expect(needsOrRepair(question, ored)).toBe(false);
    // One condition cannot be a missing alternative.
    expect(needsOrRepair(question, { conditions: [{ type: 'field' }], match: 'all' })).toBe(false);
  });
});
