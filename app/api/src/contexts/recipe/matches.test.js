import { describe, it, expect, vi } from 'vitest';
import { validateRecipe } from './recipe.js';
import { buildCandidateQuery, computeMatches, loadCandidates, TOO_BROAD_MIN_HITS } from './matches.js';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Rows as loadCandidates returns them: f0 = normalised name, f1 = normalised description.
const row = (n, name, description = '') => ({
  id: ID(n), displayName: name, description, resourceType: 'Group', systemName: 'Entra',
  f0: ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `,
  f1: ` ${description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `,
});

const recipeOf = (raw) => validateRecipe(raw).recipe;

describe('computeMatches', () => {
  const rows = [
    row(1, 'SG_Inkoop_Users'),
    row(2, 'Procurement Team', 'Inkoop afdeling'),
    row(3, 'Crediteuren'),
    row(4, 'Link Admins'),
  ];

  it('decides membership from kept terms, and records which field each term hit', () => {
    const recipe = recipeOf({ terms: ['inkoop', { text: 'crediteuren', state: 'rejected' }] });
    const r = computeMatches(rows, recipe, 100);
    expect(r.memberIds).toEqual([ID(1), ID(2)]);
    expect(r.matches.map(m => [m.displayName, m.status])).toEqual([
      ['SG_Inkoop_Users', 'member'],
      ['Procurement Team', 'member'],
      ['Crediteuren', 'candidate'],   // found only by a dropped term
      ['Link Admins', 'candidate'],   // loaded, but no term matches it
    ]);
    expect(r.matches[1].hits).toEqual([{ term: 'inkoop', fields: ['description'], accepted: true }]);
  });

  it('counts hits, per-field hits and unique hits per term', () => {
    const recipe = recipeOf({ terms: ['inkoop', 'procurement', { text: 'crediteuren', state: 'rejected' }] });
    const [inkoop, procurement, crediteuren] = computeMatches(rows, recipe, 100).terms;
    expect(inkoop).toMatchObject({ hits: 2, unique: 1, byField: { displayName: 1, description: 1 } });
    // Row 2 is found by both kept terms, so neither owns it.
    expect(procurement).toMatchObject({ hits: 1, unique: 0 });
    // A dropped term's unique count is what keeping it would add.
    expect(crediteuren).toMatchObject({ hits: 1, unique: 1, state: 'rejected' });
  });

  it('lets an exclusion win over a matching term, and an inclusion add what no term finds', () => {
    const recipe = recipeOf({ terms: ['inkoop'], exclude: [ID(1)], include: [ID(4)] });
    const r = computeMatches(rows, recipe, 100);
    expect(r.memberIds).toEqual([ID(2), ID(4)]);
    expect(r.matches.find(m => m.id === ID(1)).status).toBe('excluded');
    expect(r.matches.find(m => m.id === ID(4)).status).toBe('included');
  });

  it('groups members per kept term, an object under every term that finds it', () => {
    const recipe = recipeOf({ terms: ['inkoop', 'procurement'] });
    const { termMembers } = computeMatches(rows, recipe, 100);
    expect(termMembers.get(0)).toEqual([ID(1), ID(2)]);
    expect(termMembers.get(1)).toEqual([ID(2)]);
  });

  it('flags a term as too broad above the share of the scope, never below the minimum', () => {
    const many = Array.from({ length: TOO_BROAD_MIN_HITS + 1 }, (_, i) => row(i, `Team ${i}`));
    const recipe = recipeOf({ terms: ['team'] });
    // 26 hits of 1000: above the 25 minimum, below 10 % — not broad yet.
    expect(computeMatches(many, recipe, 1000).terms[0].tooBroad).toBe(false);
    // 26 hits of 100: above both.
    expect(computeMatches(many, recipe, 100).terms[0].tooBroad).toBe(true);
    // 26 hits of 30: 87 %, but the minimum still applies to a tiny scope.
    expect(computeMatches(many.slice(0, TOO_BROAD_MIN_HITS), recipe, 30).terms[0].tooBroad).toBe(false);
  });
});

describe('computeMatches — what the model added', () => {
  const rows = [row(1, 'HAMIS Beheer'), row(2, 'Zorg Planning'), row(3, 'Zorg Portaal'), row(4, 'HAMIS Zorg')];

  it("counts members found only by kept model terms without the analyst's own words", () => {
    const recipe = recipeOf({ terms: [{ text: 'hamis', origin: 'model', own: true }, { text: 'zorg', origin: 'model' }] });
    // Row 4 is found by both; rows 2 and 3 are only there because of "zorg".
    expect(computeMatches(rows, recipe, 100).addedByModel).toBe(2);
  });

  it('does not count terms the analyst typed or picked from related words', () => {
    const recipe = recipeOf({ terms: [{ text: 'hamis', origin: 'model', own: true }, { text: 'zorg', origin: 'related' }] });
    expect(computeMatches(rows, recipe, 100).addedByModel).toBe(0);
  });
});

describe('buildCandidateQuery', () => {
  it('uses catalog SQL for fields and passes every value as a parameter', () => {
    const recipe = recipeOf({ fields: ['displayName', 'mail'], terms: ["o'brien", { text: 'ink', match: 'token' }], include: [ID(1)], exclude: [ID(2)] });
    const q = buildCandidateQuery(recipe, { limit: 10 });
    expect(q.text).toContain('r."displayName"');
    expect(q.text).toContain('r."mail"');
    expect(q.text).not.toContain("o'brien");
    expect(q.text).toContain('LIMIT 11');   // one extra row tells "truncated" apart
    expect(q.params).toEqual([['Group'], ['% o brien%', '% ink %'], [ID(1), ID(2)]]);
    expect(q.countParams).toEqual([['Group']]);
  });

  it('still references the pattern parameter when there are no terms', () => {
    const q = buildCandidateQuery(recipeOf({ include: [ID(1)] }));
    expect(q.text).toContain('LIKE ANY($2::text[])');
    expect(q.params[1]).toEqual([]);
  });
});

describe('loadCandidates', () => {
  function fakeTx(rows, n) {
    const calls = [];
    const client = {
      query: vi.fn(async (text) => {
        calls.push(text);
        if (text.includes('count(*)')) return { rows: [{ n }] };
        if (text.startsWith('SET')) return { rows: [] };
        return { rows };
      }),
    };
    return { calls, tx: (fn) => fn(client) };
  }

  it('runs read-only with a statement timeout, and reports truncation', async () => {
    const { calls, tx } = fakeTx([row(1, 'a1'), row(2, 'a2'), row(3, 'a3')], 57);
    const r = await loadCandidates(recipeOf({ terms: ['a1'] }), tx, { limit: 2 });
    expect(calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(calls[1]).toMatch(/^SET LOCAL statement_timeout = '\d+s'$/);
    expect(r).toMatchObject({ scopeTotal: 57, truncated: true });
    expect(r.rows).toHaveLength(2);
  });

  it('is not truncated when the extra row does not come back', async () => {
    const { tx } = fakeTx([row(1, 'a1')], 1);
    expect((await loadCandidates(recipeOf({ terms: ['a1'] }), tx, { limit: 2 })).truncated).toBe(false);
  });
});
