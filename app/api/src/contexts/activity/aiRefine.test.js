import { describe, it, expect, vi, afterEach } from 'vitest';
import { refineActivityGuess, mergeActivityReply, ACTIVITY_RESPONSE_SCHEMA } from './aiRefine.js';

const COLUMNS = ['Klant', 'Medewerker', 'Mail', 'Datum', 'Tijd', 'Omschrijving'];
const profile = COLUMNS.map(name => ({ name, shape: 'text', nonEmpty: 2, distinct: 2, multiValued: 0, samples: ['a'] }));
const guess = {
  sourceLabel: 'Uren', contextColumn: 'Klant', subjectNameColumn: 'Medewerker', subjectEmailColumn: null,
  dateColumn: 'Datum', dateOrder: 'dmy', amountColumn: null, unit: 'events', kindColumn: null, attributeColumns: ['Tijd', 'Omschrijving'],
};

afterEach(() => { vi.restoreAllMocks(); });

describe('mergeActivityReply', () => {
  it('takes the fields the model got right and marks them', () => {
    const { mapping, aiFields } = mergeActivityReply(guess, { subjectEmailColumn: 'Mail', amountColumn: 'Tijd', unit: 'hours' }, COLUMNS, { hasChildren: true });
    expect(aiFields).toEqual(['subjectEmailColumn', 'amountColumn', 'unit']);
    expect(mapping).toMatchObject({ subjectEmailColumn: 'Mail', amountColumn: 'Tijd', unit: 'hours', attributeColumns: ['Omschrijving'] });
  });

  it('ignores a column that does not exist, a column taken by another role, and an unchanged field', () => {
    const { mapping, aiFields } = mergeActivityReply(guess, { kindColumn: 'Project', amountColumn: 'Klant', dateColumn: 'Datum' }, COLUMNS, { hasChildren: true });
    expect(aiFields).toEqual([]);
    expect(mapping).toEqual(guess);
  });

  it('refuses a sub-unit column on a context without sub-units', () => {
    const noChildren = { ...guess, contextColumn: null };
    expect(mergeActivityReply(noChildren, { contextColumn: 'Klant' }, COLUMNS, { hasChildren: false }).aiFields).toEqual([]);
  });

  it('may fill in what the guess lacked without being blocked by its other gaps', () => {
    const incomplete = { ...guess, dateColumn: null, subjectNameColumn: null };
    const { mapping, aiFields } = mergeActivityReply(incomplete, { dateColumn: 'Datum' }, COLUMNS, { hasChildren: true });
    expect(aiFields).toEqual(['dateColumn']);
    expect(mapping.dateColumn).toBe('Datum');
  });

  it('a reply that is not an object changes nothing', () => {
    expect(mergeActivityReply(guess, null, COLUMNS, { hasChildren: true })).toEqual({ mapping: guess, aiFields: [] });
  });
});

describe('refineActivityGuess', () => {
  it('without a model configured it asks nothing', async () => {
    const ask = vi.fn();
    expect(await refineActivityGuess({ profile, guess }, { enabled: () => false, ask })).toEqual({ mapping: guess, aiUsed: false, aiFields: [] });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks with this mapping\'s prompt and schema and merges the answer', async () => {
    const ask = vi.fn().mockResolvedValue({ subjectEmailColumn: 'Mail' });
    const out = await refineActivityGuess({ fileName: 'uren.xlsx', profile, guess, hasChildren: true }, { enabled: () => true, ask });
    expect(out).toMatchObject({ aiUsed: true, aiFields: ['subjectEmailColumn'] });
    expect(ask.mock.calls[0][0]).toBe('uren.xlsx');
    expect(ask.mock.calls[0][2].schema).toBe(ACTIVITY_RESPONSE_SCHEMA);
    expect(ask.mock.calls[0][2].systemPrompt).toMatch(/activity export/);
  });

  it('a failing or slow model leaves the guess untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error('down'));
    expect(await refineActivityGuess({ profile, guess }, { enabled: () => true, ask: failing })).toEqual({ mapping: guess, aiUsed: false, aiFields: [] });
    const slow = vi.fn(() => new Promise(() => {}));
    expect(await refineActivityGuess({ profile, guess }, { enabled: () => true, ask: slow, timeoutMs: 5 })).toMatchObject({ aiUsed: false });
  });
});
