import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('./llm.js', () => ({ chat: vi.fn(), warm: vi.fn(), DEFAULT_MODEL: 'test-model' }));

import { query } from '../db/connection.js';
import { chat, warm } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { ensureWarm, hasAnyMatch, interpret, needsOrRepair, warmupState } from './service.js';

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
    expect(warm).toHaveBeenCalledTimes(1);
    release();
    await expect(first.promise).resolves.toMatchObject({ restored: false });
    expect(warmupState()).toBe('ready');

    expect(ensureWarm()).toBe(first);   // already prepared: the prompt is not read again
    expect(warm).toHaveBeenCalledTimes(1);
    const forced = ensureWarm(true);    // ... unless asked to verify the saved cache
    await forced.promise;
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm.mock.calls[1]).toEqual(['test-model', buildSystemPrompt()]);
  });

  it('retries after a failed warm-up', async () => {
    warm.mockRejectedValueOnce(new Error('connection refused'));
    await expect(ensureWarm(true).promise).rejects.toThrow('connection refused');
    expect(warmupState()).toBe('failed');
    await expect(ensureWarm().promise).resolves.toMatchObject({ restored: true });
    expect(warmupState()).toBe('ready');
  });
});
