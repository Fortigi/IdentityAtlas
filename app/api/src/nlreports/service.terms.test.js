// interpret() and the names a question mentions. What this pins down:
//   • where a name occurs travels with the request, never in the system prompt
//   • a definition that ignores a found name gets ONE correction round, and the
//     correction is kept only when it uses the name
//   • still ignored: the analyst is asked (no guess is run), and the model's own
//     story about that name is dropped from the assumptions
//   • a name that does not occur on the report's entity is reported, not asked about
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('./llm.js', () => ({ chat: vi.fn(), warm: vi.fn(), DEFAULT_MODEL: 'test-model', MODEL_IS_FIXED: false }));

import { query } from '../db/connection.js';
import { chat, warm } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { interpret } from './service.js';

const QUESTION = 'Can you give me a list of all guest accounts from the RDW?';
const GUEST = { type: 'field', field: 'userType', op: 'eq', value: 'Guest' };
const SYSTEM_GUESS = { type: 'field', field: 'system', op: 'eq', value: 'Azure RM (3c4f204d)' };
const BY_COMPANY = { type: 'field', field: 'companyName', op: 'contains', value: 'RDW' };
const spec = (...conditions) => ({ entity: 'user', match: 'all', conditions, columns: [] });
const reply = (s, assumptions = []) => ({ content: JSON.stringify({ kind: 'report', assumptions, spec: s }), timing: { totalMs: 10 } });

// Where "RDW" is (user email + company) is decided per EXISTS clause; everything else is a value list.
let occursOn;
beforeEach(() => {
  chat.mockReset();
  warm.mockResolvedValue({ model: 'test-model', ms: 1, restored: true });
  occursOn = (clause) => clause.includes(`"principalType" = 'User'`) && /"(email|companyName)"/.test(clause);
  query.mockReset();
  query.mockImplementation(async (sql) => {
    if (sql.includes('EXISTS')) {
      const clauses = sql.split(/ AS f\d+/).slice(0, -1);
      return { rows: [Object.fromEntries(clauses.map((c, i) => [`f${i}`, occursOn(c)]))] };
    }
    if (sql.includes('"Systems"')) return { rows: [{ v: 'Azure RM (3c4f204d)' }] };
    return { rows: [{ v: 'Guest' }, { v: 'Member' }] };
  });
});

describe('interpret — names from the question', () => {
  it('tells the model where a name occurs, in the request and not in the system prompt', async () => {
    chat.mockResolvedValueOnce(reply(spec(GUEST, BY_COMPANY)));
    const r = await interpret({ question: QUESTION, model: 'm' });

    const [system, user] = chat.mock.calls[0][0].messages;
    expect(system.content).toBe(buildSystemPrompt());
    expect(system.content).not.toContain('RDW');
    expect(user.content).toMatch(/- "RDW": user\.email, user\.companyName — not a system name\n\nRequest: Can you give/);
    expect(r).toMatchObject({ kind: 'report', repaired: false });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('asks once for a correction when the definition ignores the name, and takes it', async () => {
    chat.mockResolvedValueOnce(reply(spec(GUEST, SYSTEM_GUESS))).mockResolvedValueOnce(reply(spec(GUEST, BY_COMPANY)));
    const r = await interpret({ question: QUESTION, model: 'm' });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].messages.at(-1).content).toMatch(/mentions "RDW", but your definition does not use it\. "RDW" occurs in: user\.email, user\.companyName/);
    expect(r).toMatchObject({ kind: 'report', repaired: true });
    expect(r.spec.conditions).toEqual([GUEST, BY_COMPANY]);
  });

  it('asks the analyst when the correction still ignores the name, without the model\'s story about it', async () => {
    const assumptions = ['"RDW" is assumed to refer to the system Azure RM.', 'Guest accounts are userType Guest.'];
    // The correction is valid but ignores the name just as much: the first definition stays.
    chat.mockResolvedValueOnce(reply(spec(GUEST, SYSTEM_GUESS), assumptions)).mockResolvedValueOnce(reply(spec(SYSTEM_GUESS), assumptions));
    const r = await interpret({ question: QUESTION, model: 'm' });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(r.kind).toBe('confirm');
    expect(r.spec.conditions).toEqual([GUEST, SYSTEM_GUESS]);
    expect(r.confirm).toMatchObject({ kind: 'term', name: 'RDW', drop: [[1]] });
    expect(r.confirm.choices.map(c => c.fields)).toEqual([['email'], ['companyName'], ['email', 'companyName']]);
    expect(r.assumptions).toEqual(['Guest accounts are userType Guest.']);
    expect(r.sql).toBeUndefined();   // nothing runs on the guess
  });

  it('keeps the first definition when the correction is not valid', async () => {
    const broken = spec(GUEST, { type: 'field', field: 'noSuchField', op: 'eq', value: 'RDW' });
    chat.mockResolvedValueOnce(reply(spec(GUEST, SYSTEM_GUESS))).mockResolvedValueOnce(reply(broken));
    const r = await interpret({ question: QUESTION, model: 'm' });
    expect(r.kind).toBe('confirm');
    expect(r.spec.conditions).toEqual([GUEST, SYSTEM_GUESS]);
  });

  it('says a name is unused when it does not occur on the report entity, instead of asking', async () => {
    occursOn = (clause) => clause.includes('"Resources"') && clause.includes('"displayName"');
    chat.mockResolvedValue(reply(spec(GUEST)));
    const r = await interpret({ question: QUESTION, model: 'm' });

    expect(chat).toHaveBeenCalledTimes(2);   // the correction round was still tried
    expect(r.kind).toBe('report');
    expect(r.assumptions).toEqual(['“RDW” from the request is not used in this report.']);
  });

  it('looks nothing up and adds no hint when the question names nothing', async () => {
    chat.mockResolvedValueOnce(reply(spec(GUEST)));
    await interpret({ question: 'all guest accounts', model: 'm' });
    expect(query.mock.calls.some(([sql]) => sql.includes('EXISTS'))).toBe(false);
    expect(chat.mock.calls[0][0].messages[1].content).not.toMatch(/Where the names/);
  });
});
