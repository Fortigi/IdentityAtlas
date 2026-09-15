import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('./llm.js', () => ({ chat: vi.fn(), DEFAULT_MODEL: 'test-model' }));

import { query } from '../db/connection.js';
import { chat } from './llm.js';
import { hasAnyMatch, needsOrRepair, interpret } from './service.js';

const AND_SPEC = { entity: 'user', match: 'all', conditions: [
  { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
  { type: 'relation', relation: 'manager', quantifier: 'none', match: 'all', conditions: [] },
  { type: 'relation', relation: 'manager', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'accountEnabled', op: 'eq', value: false }] },
] };
const OR_SPEC = { ...AND_SPEC, conditions: [AND_SPEC.conditions[0], { type: 'group', match: 'any', conditions: AND_SPEC.conditions.slice(1) }] };
const reply = (spec) => ({ content: JSON.stringify({ kind: 'report', assumptions: [], spec }), timing: { totalMs: 10, promptTokens: 1, promptMs: 1, outputTokens: 1, outputMs: 1, loadMs: 0 } });

beforeEach(() => {
  chat.mockReset();
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
