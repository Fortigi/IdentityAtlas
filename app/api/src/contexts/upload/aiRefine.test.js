import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../nlreports/llm.js', () => ({ chat: vi.fn() }));
vi.mock('../../nlreports/settings.js', () => ({ getReportModel: vi.fn().mockResolvedValue('m') }));
const { chat } = await import('../../nlreports/llm.js');
const { refineGuess, mergeReply, withTimeout, buildUserMessage, aiConfigured, AI_TIMEOUT_MS, RESPONSE_SCHEMA } = await import('./aiRefine.js');

const COLUMNS = ['Naam', 'Code', 'Eigenaar', 'Leden', 'Sector'];
const guess = {
  template: 'OrganizationalUnit', listName: 'Klanten', nameColumn: 'Naam', keyColumn: 'Naam',
  ownerColumn: null, responsibleColumn: null, parentColumn: null,
  memberColumns: [{ column: 'Leden', kind: 'Principal', shape: 'long' }], attributeColumns: ['Code', 'Eigenaar', 'Sector'],
};
const profile = COLUMNS.map((name, index) => ({ name, index, shape: 'text', nonEmpty: 2, distinct: 2, multiValued: 0, samples: ['a', 'b', 'c', 'd'] }));

afterEach(() => { vi.useRealTimers(); delete process.env.NL_REPORTS_LLM_URL; chat.mockReset(); });

describe('mergeReply', () => {
  it('takes the fields the model got right, marks them, and recomputes the attributes', () => {
    const reply = { keyColumn: 'Code', ownerColumn: 'Eigenaar', nameColumn: 'Naam', template: 'OrganizationalUnit' };
    const { mapping, aiFields } = mergeReply(guess, reply, COLUMNS);
    expect(aiFields).toEqual(['keyColumn', 'ownerColumn']);
    expect(mapping).toMatchObject({ keyColumn: 'Code', ownerColumn: 'Eigenaar' });
    expect(mapping.attributeColumns).toEqual(['Sector']);
  });

  it('keeps the heuristic value of a field the model got wrong', () => {
    const reply = { nameColumn: 'Invented', template: 'Tag', keyColumn: 'Code' };
    const { mapping, aiFields } = mergeReply(guess, reply, COLUMNS);
    expect(mapping.nameColumn).toBe('Naam');
    expect(mapping.template).toBe('OrganizationalUnit');
    expect(aiFields).toEqual(['keyColumn']);
  });

  it('a member reply keeps the shape the heuristic saw for a column it already had', () => {
    const reply = { memberColumns: [{ column: 'Leden', kind: 'Identity' }] };
    const { mapping, aiFields } = mergeReply(guess, reply, COLUMNS);
    expect(mapping.memberColumns).toEqual([{ column: 'Leden', kind: 'Identity', shape: 'long' }]);
    expect(aiFields).toEqual(['memberColumns']);
  });

  it('three member kinds are refused whole', () => {
    const reply = { memberColumns: [{ column: 'Leden', kind: 'Identity' }, { column: 'Code', kind: 'Principal' }, { column: 'Sector', kind: 'Resource' }] };
    expect(mergeReply(guess, reply, COLUMNS).aiFields).toEqual([]);
  });

  it('a reply that agrees with the guess changes nothing and marks nothing', () => {
    expect(mergeReply(guess, { ...guess }, COLUMNS)).toEqual({ mapping: guess, aiFields: [] });
  });
});

describe('refineGuess', () => {
  it('without a model server it returns the guess untouched and never calls the model', async () => {
    const out = await refineGuess({ fileName: 'k.csv', profile, guess });
    expect(out).toEqual({ mapping: guess, aiUsed: false, aiFields: [] });
    expect(chat).not.toHaveBeenCalled();
    expect(aiConfigured()).toBe(false);
  });

  it('with a model server it asks once with the schema and merges the answer', async () => {
    process.env.NL_REPORTS_LLM_URL = 'http://llm:8080';
    chat.mockResolvedValue({ content: JSON.stringify({ ownerColumn: 'Eigenaar' }) });
    const out = await refineGuess({ fileName: 'k.csv', profile, guess });
    expect(out).toMatchObject({ aiUsed: true, aiFields: ['ownerColumn'] });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toMatchObject({ model: 'm', schema: RESPONSE_SCHEMA });
  });

  it('an unparseable answer leaves the guess and reports the model as not used', async () => {
    chat.mockResolvedValue({ content: 'not json' });
    const out = await refineGuess({ fileName: 'k.csv', profile, guess }, { enabled: () => true });
    expect(out).toEqual({ mapping: guess, aiUsed: false, aiFields: [] });
  });

  it(`gives up after the budget (${AI_TIMEOUT_MS} ms by default) and keeps the guess`, async () => {
    vi.useFakeTimers();
    const pending = refineGuess({ fileName: 'k.csv', profile, guess }, { enabled: () => true, ask: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS - 1);
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ mapping: guess, aiUsed: false, aiFields: [] });
  });
});

describe('withTimeout / buildUserMessage', () => {
  it('passes a fast answer through', async () => {
    await expect(withTimeout(Promise.resolve(5), 10)).resolves.toBe(5);
  });

  it('describes each column on one line with at most three samples', () => {
    const text = buildUserMessage('klanten.csv', profile);
    expect(text.split('\n')).toHaveLength(2 + COLUMNS.length);
    expect(text).toContain('- "Naam" | text | filled 2 | distinct 2 | several per cell no | samples: "a", "b", "c"');
    expect(text).not.toContain('"d"');
  });
});
