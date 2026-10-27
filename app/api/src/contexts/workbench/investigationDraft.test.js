import { describe, it, expect } from 'vitest';
import {
  parseDraft, parsePerson, personKeyOf, parseView, parseCells, parseMarks, parseProposal, parseProposals, parseReadAt, parseName,
  InvestigationError, ACCESS_TYPES, MAX_CELLS, MAX_PROPOSALS, MAX_VIEW_BYTES,
} from './investigationDraft.js';

const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RES = '99999999-8888-4777-8666-555555555555';

const refused = (fn, message) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(InvestigationError);
  expect(err.status).toBe(400);
  if (message) expect(err.message).toMatch(message);
};

describe('parsePerson / personKeyOf', () => {
  it('reads both row keys and writes them back', () => {
    expect(parsePerson(`i:${ID}`)).toEqual({ personKind: 'identity', personId: ID });
    expect(parsePerson(`P:${ID.toUpperCase()}`)).toEqual({ personKind: 'principal', personId: ID });
    expect(personKeyOf('identity', ID)).toBe(`i:${ID}`);
    expect(personKeyOf('principal', ID)).toBe(`p:${ID}`);
  });

  it.each([[`x:${ID}`], [ID], [`i:${ID}x`], [42], [null]])('is null for %s', (key) => {
    expect(parsePerson(key)).toBeNull();
  });
});

describe('parseName / parseReadAt', () => {
  it('trims and cuts the name, and refuses an empty one', () => {
    expect(parseName('  Motor  ')).toBe('Motor');
    expect(parseName('x'.repeat(300))).toHaveLength(200);
    refused(() => parseName('   '), /name/);
    refused(() => parseName(undefined), /name/);
    refused(() => parseName(7), /text/);
  });

  it('normalises a date and refuses what is not one', () => {
    expect(parseReadAt('2026-10-27T10:00:00+02:00')).toBe('2026-10-27T08:00:00.000Z');
    expect(parseReadAt(null)).toBeNull();
    expect(parseReadAt('')).toBeNull();
    refused(() => parseReadAt('yesterday'), /date/);
    refused(() => parseReadAt(1700000000000), /date/);
  });
});

describe('parseView', () => {
  it('keeps only the workbench view keys', () => {
    expect(parseView({ columns: ['name'], filters: { activity: { values: ['x'] } }, sort: null, evil: 'DROP', groupBy: 'none' }))
      .toEqual({ columns: ['name'], filters: { activity: { values: ['x'] } }, sort: null, groupBy: 'none' });
    expect(parseView(undefined)).toEqual({});
  });

  it('refuses a list, a scalar and a view too large to save', () => {
    refused(() => parseView([]), /object/);
    refused(() => parseView('x'), /object/);
    refused(() => parseView({ columnSearch: 'x'.repeat(MAX_VIEW_BYTES) }), /too large/);
  });
});

describe('parseCells', () => {
  it('lower-cases ids, keeps the type spelled as the workbench does, drops duplicates', () => {
    expect(parseCells([`i:${ID.toUpperCase()}|${RES}|direct`, `i:${ID}|${RES}|Direct`, `p:${ID2}|${RES}|Eligible`]))
      .toEqual([`i:${ID}|${RES}|Direct`, `p:${ID2}|${RES}|Eligible`]);
  });

  it('accepts every grant type the workbench shows, and only those', () => {
    expect(parseCells(ACCESS_TYPES.map(t => `i:${ID}|${RES}|${t}`))).toHaveLength(ACCESS_TYPES.length);
    expect(ACCESS_TYPES).toEqual(['Direct', 'Indirect', 'Eligible']);
  });

  it.each([[`i:${ID}|${RES}`], [`i:${ID}|${RES}|Owner`], [`${ID}|${RES}|Direct`], [7]])('refuses %s', (cell) => {
    refused(() => parseCells([cell]), /person\|resource\|type/);
  });

  it('refuses more cells than the workbench can show, and a non-list', () => {
    refused(() => parseCells(new Array(MAX_CELLS + 1).fill(`i:${ID}|${RES}|Direct`)), /at most/);
    refused(() => parseCells('x'), /list/);
  });
});

describe('parseMarks', () => {
  it('reads a mark and keeps the later of two on the same cell', () => {
    const marks = parseMarks([
      { person: `i:${ID}`, resourceId: RES, mark: 'other', note: ' OR ' },
      { person: `p:${ID2}`, resourceId: RES, mark: 'unrelated' },
      { person: `i:${ID}`, resourceId: RES.toUpperCase(), mark: 'investigate' },
    ]);
    expect(marks).toEqual([
      { personKind: 'identity', personId: ID, resourceId: RES, mark: 'investigate', note: null },
      { personKind: 'principal', personId: ID2, resourceId: RES, mark: 'unrelated', note: null },
    ]);
    expect(parseMarks([{ person: `i:${ID}`, resourceId: RES, mark: 'other', note: ' OR ' }])[0].note).toBe('OR');
  });

  it('refuses a mark on no person, no resource or with an unknown value', () => {
    refused(() => parseMarks([{ person: 'Anna', resourceId: RES, mark: 'other' }]), /person/);
    refused(() => parseMarks([{ person: `i:${ID}`, resourceId: 'x', mark: 'other' }]), /resource/);
    refused(() => parseMarks([{ person: `i:${ID}`, resourceId: RES, mark: 'revoke' }]), /one of/);
    refused(() => parseMarks([null]), /person/);
  });
});

describe('parseProposal / parseProposals', () => {
  const full = {
    id: ID.toUpperCase(), name: ' Claims handler ', description: ' motor ', baseBusinessRoleId: RES,
    members: [`i:${ID}`, `i:${ID}`, `p:${ID2}`], entitlements: [RES, RES.toUpperCase()], evidenceClaimIds: [ID2],
  };

  it('reads a proposal on an existing role as an extension of it', () => {
    expect(parseProposal(full)).toEqual({
      id: ID, mode: 'extend', baseBusinessRoleId: RES, name: 'Claims handler', description: 'motor',
      members: [{ personKind: 'identity', personId: ID }, { personKind: 'principal', personId: ID2 }],
      entitlements: [RES], evidenceClaimIds: [ID2],
    });
  });

  it('reads one without a base role as a new role, with an empty name allowed', () => {
    expect(parseProposal({ members: [] })).toMatchObject({ id: null, mode: 'new', baseBusinessRoleId: null, name: '', description: null });
    expect(parseProposal({ baseRoleId: RES }).baseBusinessRoleId).toBe(RES);
  });

  it('refuses a proposal that is not an object, a member that is no row, an entitlement that is no id', () => {
    refused(() => parseProposal([]), /object/);
    refused(() => parseProposal({ members: ['Anna'] }), /member/);
    refused(() => parseProposal({ entitlements: ['x'] }), /entitlements/);
  });

  it('treats the browser’s handle of an unsaved draft as no id: a new proposal', () => {
    expect(parseProposal({ id: 'draft:3', name: 'Candidate 3' }).id).toBeNull();
    expect(parseProposal({ id: 42 }).id).toBeNull();
    expect(parseProposals({ proposals: [{ id: 'draft:1' }, { id: 'draft:1' }] })).toHaveLength(2);
  });

  it('reads every proposal, in order, or the single panel candidate', () => {
    expect(parseProposals({ proposals: [{ name: 'A' }, { name: 'B' }] }).map(p => p.name)).toEqual(['A', 'B']);
    expect(parseProposals({ candidate: { name: 'Only' } }).map(p => p.name)).toEqual(['Only']);
    expect(parseProposals({ proposals: [], candidate: { name: 'ignored' } })).toEqual([]);
    expect(parseProposals({})).toEqual([]);
  });

  it('refuses two proposals with one id, and too many', () => {
    refused(() => parseProposals({ proposals: [{ id: ID }, { id: ID.toUpperCase() }] }), /same id/);
    refused(() => parseProposals({ proposals: new Array(MAX_PROPOSALS + 1).fill({}) }), /at most/);
  });
});

describe('parseDraft', () => {
  it('needs a name for a new investigation, not for a save over one', () => {
    refused(() => parseDraft({}, { requireName: true }), /name/);
    const update = parseDraft({}, { requireName: false });
    expect(update.name).toBeUndefined();
    expect(update.description).toBeUndefined();
    expect(update).toMatchObject({ view: {}, accessReadAt: null, accessCells: [], marks: [], proposals: [], expectedUpdatedAt: null });
  });

  it('reads a renamed save, a cleared description and the time it was opened at', () => {
    const d = parseDraft({ name: 'New', description: '', expectedUpdatedAt: '2026-10-27T09:00:00.123Z' }, { requireName: false });
    expect(d).toMatchObject({ name: 'New', description: null, expectedUpdatedAt: '2026-10-27T09:00:00.123Z' });
  });

  it('treats a body that is not an object as empty', () => {
    expect(parseDraft([1], { requireName: false }).marks).toEqual([]);
    expect(parseDraft(null, { requireName: false }).proposals).toEqual([]);
  });
});
