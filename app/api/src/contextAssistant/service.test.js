import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../nlreports/llm.js', () => ({ chat: vi.fn(), warm: vi.fn() }));
vi.mock('../nlreports/settings.js', () => ({ getReportModel: vi.fn(async () => 'test-model') }));

import { chat, warm } from '../nlreports/llm.js';
import { containsOwnWord, interpret, isGenericTerm, ownWords, schemaFor, shapeTerms, suggestMore } from './service.js';
import { buildContextPrompt, MORE_TERMS_SCHEMA, RESPONSE_SCHEMA, TERMS_ONLY_SCHEMA } from './prompt.js';
import { validateRecipe } from '../contexts/recipe/recipe.js';

const reply = (obj) => ({ content: JSON.stringify(obj), timing: { totalMs: 1000 } });

beforeEach(() => {
  chat.mockReset();
  warm.mockReset();
  warm.mockResolvedValue({ model: 'test-model', ms: 1, restored: true });
});

describe('ownWords', () => {
  it("keeps the subject words of the request and of the analyst's earlier answers", () => {
    expect(ownWords('Alle groepen rond het inkoopproces')).toEqual(['inkoopproces']);
    expect(ownWords('everything to do with HAMIS', [
      { role: 'user', content: 'the Zaaksysteem' },
      { role: 'assistant', content: '{"kind":"clarify"}' },
    ])).toEqual(['hamis', 'zaaksysteem']);
    expect(ownWords('groups that hand out licences')).toEqual(['licences']);
  });

  it('matches a term word to an own word when equal, or when both share their first five letters', () => {
    expect(containsOwnWord('inkoop', ['inkoopproces'])).toBe(true);
    expect(containsOwnWord('license distribution', ['licences'])).toBe(true);
    expect(containsOwnWord('hamis platform', ['hamis'])).toBe(true);
    expect(containsOwnWord('zorg', ['hamis'])).toBe(false);
    // Short words must be equal: "ham" is not "hamis".
    expect(containsOwnWord('ham', ['hamis'])).toBe(false);
    expect(containsOwnWord('procurement', ['process'])).toBe(false);
  });
});

describe('shapeTerms', () => {
  it("ticks only terms with the analyst's own words; the model's additions arrive unticked", () => {
    // What the model really answered for "everything to do with HAMIS".
    const terms = shapeTerms([
      { text: 'HAMIS', why: 'name' }, { text: 'health', why: 'activity' }, { text: 'zorg', why: 'translation' },
      { text: 'HAMIS platform', why: 'system' },
    ], new Set(), ['hamis']);
    expect(terms.map(t => [t.text, t.state, t.own])).toEqual([
      ['HAMIS', 'accepted', true], ['health', 'rejected', false], ['zorg', 'rejected', false], ['HAMIS platform', 'accepted', true],
    ]);
  });

  it('normalises, de-duplicates and keeps generic terms unticked even with an own word', () => {
    const terms = shapeTerms([
      { text: ' Inkoop ', why: 'name' },
      { text: 'INKOOP', why: 'synonym' },            // same term again
      { text: 'beheer', why: 'related' },            // every subject has "beheer"
      { text: 'x', why: 'name' },                    // too short
      { text: 'P2P', why: 'abbreviation' },
    ], new Set(), ['inkoop', 'beheer']);
    expect(terms).toEqual([
      { text: 'Inkoop', match: 'wordStart', state: 'accepted', origin: 'model', own: true, why: 'name' },
      { text: 'beheer', match: 'wordStart', state: 'rejected', origin: 'model', own: false, why: 'too generic' },
      { text: 'P2P', match: 'token', state: 'rejected', origin: 'model', own: false, why: 'abbreviation' },
    ]);
  });

  it('skips terms the builder already has', () => {
    expect(shapeTerms([{ text: 'Coupa', why: 'system' }, { text: 'Ariba', why: 'system' }], new Set(['coupa'])).map(t => t.text)).toEqual(['Ariba']);
  });

  it('isGenericTerm needs every word to be generic', () => {
    expect(isGenericTerm('admins prod')).toBe(true);
    expect(isGenericTerm('hamis admins')).toBe(false);
  });
});

describe('schemaFor', () => {
  const clarify = { role: 'assistant', content: JSON.stringify({ kind: 'clarify', question: 'q', options: [] }) };
  it('allows a clarifying question until two have been asked', () => {
    expect(schemaFor([])).toBe(RESPONSE_SCHEMA);
    expect(schemaFor([clarify, { role: 'user', content: 'a' }])).toBe(RESPONSE_SCHEMA);
    expect(schemaFor([clarify, { role: 'user', content: 'a' }, clarify, { role: 'user', content: 'b' }])).toBe(TERMS_ONLY_SCHEMA);
  });
});

describe('interpret', () => {
  it('restores this prompt before asking, and returns shaped terms', async () => {
    chat.mockResolvedValueOnce(reply({ kind: 'terms', name: ' Inkoop ', terms: [{ text: 'inkoop', why: 'name' }], notes: ['n1'] }));
    const r = await interpret({ question: 'inkoopgroepen' });
    expect(warm).toHaveBeenCalledWith('test-model', buildContextPrompt());
    expect(warm.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]);
    const { messages, schema } = chat.mock.calls[0][0];
    expect(messages[0]).toEqual({ role: 'system', content: buildContextPrompt() });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'inkoopgroepen' });
    expect(schema).toBe(RESPONSE_SCHEMA);
    expect(r).toMatchObject({ kind: 'terms', name: 'Inkoop', notes: ['n1'], terms: [{ text: 'inkoop', state: 'accepted', own: true }] });
  });

  it('still asks when the warm-up fails', async () => {
    warm.mockRejectedValueOnce(new Error('down'));
    chat.mockResolvedValueOnce(reply({ kind: 'clarify', question: 'Which subject?', options: ['A process'] }));
    expect(await interpret({ question: 'important groups' })).toMatchObject({ kind: 'clarify', question: 'Which subject?', options: ['A process'] });
  });

  it('reports a reply that is not JSON', async () => {
    chat.mockResolvedValueOnce({ content: 'not json', timing: {} });
    expect(await interpret({ question: 'x' })).toMatchObject({ kind: 'error', raw: 'not json' });
  });
});

describe('suggestMore', () => {
  it('sends kept and dropped terms and returns only new ones', async () => {
    const { recipe } = validateRecipe({ terms: ['inkoop', { text: 'order', state: 'rejected' }] });
    chat.mockResolvedValueOnce(reply({ kind: 'terms', name: 'Inkoop', notes: [], terms: [{ text: 'Inkoop', why: 'name' }, { text: 'crediteuren', why: 'activity' }] }));
    const r = await suggestMore({ question: 'inkoopgroepen', recipe });
    const { messages, schema } = chat.mock.calls[0][0];
    expect(schema).toBe(MORE_TERMS_SCHEMA);
    expect(messages[1].content).toContain('Terms the analyst kept: inkoop');
    expect(messages[1].content).toContain('Terms the analyst dropped: order');
    expect(r.terms.map(t => t.text)).toEqual(['crediteuren']);
  });

  it('answers an error when the model does not return terms', async () => {
    const { recipe } = validateRecipe({ terms: ['inkoop'] });
    chat.mockResolvedValueOnce(reply({ kind: 'clarify', question: 'q', options: [] }));
    expect((await suggestMore({ question: 'q', recipe })).kind).toBe('error');
  });
});

describe('reply grammar', () => {
  it('bounds every list and string the model can repeat', () => {
    const terms = TERMS_ONLY_SCHEMA.properties.terms;
    expect(terms.maxItems).toBe(15);
    expect(terms.items.properties.text.maxLength).toBe(40);
    expect(TERMS_ONLY_SCHEMA.properties.notes.maxItems).toBe(3);
    expect(MORE_TERMS_SCHEMA.properties.terms.maxItems).toBe(10);
  });

  it('keeps the prompt free of the subjects it is tested on', () => {
    // An example about a test subject makes the model copy it and the test pass for the wrong reason.
    const prompt = buildContextPrompt().toLowerCase();
    for (const subject of ['inkoop', 'procurement', 'hamis', 'devops', 'licen']) expect(prompt).not.toContain(subject);
  });
});
