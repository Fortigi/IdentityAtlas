// The Entitlement Pivot's context blocks: every attribute of each context, and
// who answers for it — or who the page would suggest, and why.
//
// The suggestion is the context page's own (contexts/roleSuggestion.js), called
// for real here with the db mocked, so a rejected candidate staying rejected is
// pinned by the SQL it sends rather than by a stub.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import {
  MAX_CELL_TEXT, MAX_SUGGESTIONS, attributeEntries, cellValue, detailBlock, detailLabel,
  fetchContextDetails, peopleEntries, personText, wantsSuggestion,
} from './contextDetails.js';

const APP = '11111111-1111-1111-1111-111111111111';
const TAG = '22222222-2222-2222-2222-222222222222';

const row = over => ({
  id: APP,
  displayName: 'Ledger',
  variant: 'synced',
  targetType: 'Resource',
  contextType: 'LogicalApplication',
  contextCategory: 'LogicalApplication',
  externalId: 'APP-0006',
  scopeSystemId: 7,
  scopeSystemName: 'IdentityIQ',
  ownerUserId: '10007339',
  lastSyncedAt: new Date('2026-10-01T06:00:00Z'),
  totalMemberCount: 3,
  SysStartTime: new Date('2026-01-01T00:00:00Z'),
  description: '',
  extendedAttributes: { cmdbReference: 'CI5505557', zoning: { tier: 2, zones: ['dmz'] }, empty: '' },
  ...over,
});

const labels = entries => entries.map(e => e.label);
const valueOf = (entries, label) => entries.find(e => e.label === label)?.value;

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('cellValue', () => {
  it('keeps numbers and booleans typed, and writes a date as ISO text', () => {
    expect(cellValue(0)).toBe(0);
    expect(cellValue(false)).toBe(false);
    expect(cellValue(new Date('2026-10-01T06:00:00Z'))).toBe('2026-10-01T06:00:00.000Z');
  });

  it('writes anything nested as its JSON, and blanks as nothing', () => {
    expect(cellValue({ tier: 2, zones: ['dmz'] })).toBe('{"tier":2,"zones":["dmz"]}');
    expect(cellValue(['a', 'b'])).toBe('["a","b"]');
    expect(cellValue('   ')).toBeNull();
    expect(cellValue(undefined)).toBeNull();
  });

  it('stops at what one Excel cell holds', () => {
    expect(cellValue('x'.repeat(MAX_CELL_TEXT + 5))).toHaveLength(32767);
    expect(cellValue('x'.repeat(MAX_CELL_TEXT))).toHaveLength(32767);
  });
});

describe('detailLabel', () => {
  it('uses the page\'s words where it has them, and splits the column name otherwise', () => {
    expect(detailLabel('scopeSystemName')).toBe('Source system');
    expect(detailLabel('lastCalculatedAt')).toBe('Last updated');
    expect(detailLabel('lastSyncedAt')).toBe('Last Synced At');
    // An own-property lookup: a column named like an Object member is still split.
    expect(detailLabel('constructor')).toBe('Constructor');
  });
});

describe('attributeEntries', () => {
  it('lists the context\'s own columns, then every stored attribute by name, nested ones as JSON', () => {
    const entries = attributeEntries(row());
    expect(labels(entries)).toEqual([
      'Id', 'Name', 'Variant', 'Target Type', 'Context Type', 'Context Category', 'External Id',
      'Source system', 'Owner (as the source names it)', 'Last Synced At', 'Total Member Count',
      'cmdbReference', 'zoning',
    ]);
    expect(valueOf(entries, 'Last Synced At')).toBe('2026-10-01T06:00:00.000Z');
    expect(valueOf(entries, 'Total Member Count')).toBe(3);
    expect(valueOf(entries, 'zoning')).toBe('{"tier":2,"zones":["dmz"]}');
  });

  it('copes with a context without attributes', () => {
    expect(labels(attributeEntries({ displayName: 'Bare', extendedAttributes: null }))).toEqual(['Name']);
  });
});

describe('the people', () => {
  it('writes a person as name, employee ID and e-mail, leaving out what is unknown', () => {
    expect(personText({ displayName: 'Ada', employeeId: 'E-1', email: 'ada@x' })).toBe('Ada · E-1 · ada@x');
    expect(personText({ displayName: 'Ada', employeeId: null, email: 'ada@x' })).toBe('Ada · ada@x');
    expect(personText({})).toBeNull();
  });

  it('shows the Accountable and every Responsible, and no suggestion beside an Accountable', () => {
    const entries = peopleEntries([
      { role: 'Accountable', displayName: 'Ada', employeeId: 'E-1', email: null },
      { role: 'Responsible', displayName: 'Grace', employeeId: null, email: 'g@x' },
      { role: 'Responsible', displayName: 'Linus', employeeId: 'E-3', email: null },
    ], { displayName: 'Ignored', reason: 'owns all 3 resources' });
    expect(entries).toEqual([
      { label: 'Accountable', value: 'Ada · E-1' },
      { label: 'Responsible', value: 'Grace · g@x' },
      { label: 'Responsible', value: 'Linus · E-3' },
    ]);
  });

  it('states an empty Accountable and the suggestion with its reason when nobody is accountable', () => {
    expect(peopleEntries([], { displayName: 'Grace Hopper', reason: 'owns 2 of the 3 resources' })).toEqual([
      { label: 'Accountable', value: null },
      { label: 'Suggested Accountable', value: 'Grace Hopper · owns 2 of the 3 resources' },
      { label: 'Responsible', value: null },
    ]);
    expect(labels(peopleEntries([], null))).toEqual(['Accountable', 'Responsible']);
  });

  it('asks for a suggestion only where the page would: a role-bearing context without an Accountable', () => {
    expect(wantsSuggestion(row(), [])).toBe(true);
    expect(wantsSuggestion(row(), [{ role: 'Responsible' }])).toBe(true);
    expect(wantsSuggestion(row(), [{ role: 'Accountable' }])).toBe(false);
    expect(wantsSuggestion(row({ contextCategory: 'Tag' }), [])).toBe(false);
  });

  it('titles a block after its context and puts the people first', () => {
    const block = detailBlock(row({ extendedAttributes: {} }));
    expect(block.title).toBe('Context: Ledger');
    expect(labels(block.entries).slice(0, 3)).toEqual(['Accountable', 'Responsible', 'Id']);
  });
});

// ─── the reads ─────────────────────────────────────────────────────────────

function stage({ contexts = [row()], roles = [], total = 3, candidates = [] } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT c.*')) return { rows: contexts };
    if (sql.includes('FROM "ContextRoles" r')) return { rows: roles };
    if (sql.includes('ContextRoleSuggestionRejections')) return { rows: candidates };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
  queryOne.mockResolvedValue({ total });
}

describe('fetchContextDetails', () => {
  it('reads nothing for no contexts', async () => {
    expect(await fetchContextDetails([])).toEqual({ details: [], notices: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('gives one block per context, with its roles, and suggests only for the one without an Accountable', async () => {
    stage({
      contexts: [row(), row({ id: TAG, displayName: 'Archive', contextCategory: 'LogicalApplication' })],
      roles: [{ contextId: TAG, role: 'Accountable', displayName: 'Ada', employeeId: 'E-1', email: 'ada@x' }],
      candidates: [{ id: 'p9', displayName: 'Grace Hopper', count: 2 }],
    });
    const { details, notices } = await fetchContextDetails([{ id: APP }, { id: TAG }]);
    expect(details.map(d => d.title)).toEqual(['Context: Ledger', 'Context: Archive']);
    expect(valueOf(details[0].entries, 'Suggested Accountable')).toBe('Grace Hopper · owns 2 of the 3 resources');
    expect(valueOf(details[1].entries, 'Accountable')).toBe('Ada · E-1 · ada@x');
    expect(labels(details[1].entries)).not.toContain('Suggested Accountable');
    expect(notices).toEqual([]);

    // Both contexts in one read each; the suggestion's SQL leaves out rejected candidates.
    const contextReads = query.mock.calls.filter(([sql]) => sql.includes('SELECT c.*') || sql.includes('FROM "ContextRoles" r'));
    expect(contextReads).toHaveLength(2);
    for (const [, params] of contextReads) expect(params).toEqual([[APP, TAG]]);
    const suggestionCalls = query.mock.calls.filter(([sql]) => sql.includes('ContextRoleSuggestionRejections'));
    expect(suggestionCalls.map(([, params]) => params)).toEqual([[APP]]);
  });

  it('shows no suggestion when no candidate reaches the threshold', async () => {
    stage({ candidates: [{ id: 'p9', displayName: 'Grace Hopper', count: 1 }], total: 3 });
    const { details } = await fetchContextDetails([{ id: APP }]);
    expect(labels(details[0].entries)).not.toContain('Suggested Accountable');
  });

  it('suggests for the first contexts only, and says so', async () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 2 }, (_, i) => row({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, displayName: `App ${i}`,
    }));
    stage({ contexts: many, candidates: [] });
    const { details, notices } = await fetchContextDetails(many);
    expect(details).toHaveLength(MAX_SUGGESTIONS + 2);
    expect(queryOne).toHaveBeenCalledTimes(MAX_SUGGESTIONS);
    expect(notices).toEqual([{
      severity: 'info',
      text: `${MAX_SUGGESTIONS + 2} contexts have no Accountable; a suggestion is shown for the first ${MAX_SUGGESTIONS} only.`,
    }]);
  });
});
