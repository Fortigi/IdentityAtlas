import { describe, it, expect } from 'vitest';
import { viewToSave, viewFromSaved, accessCellsOf, toSavePayload, draftFromSaved, fingerprint, accessChanges, statusText, defaultInvestigationName } from './workbench.save';
import { DEFAULT_COLUMNS } from './workbench.columns';

const SAVED_ID = '11111111-2222-4333-8444-555555555555';
const DEFAULTS = { groupBy: 'none', columns: DEFAULT_COLUMNS, filters: {}, sort: null, includeChildren: true, minHolders: null, columnSearch: '' };

const draftState = (over = {}) => ({
  selection: new Set(['i:a|r1']), marks: new Map([['i:b|or', 'other'], ['i:a|r2', 'investigate']]), activeId: 'draft:1', nextId: 2,
  drafts: [{ id: 'draft:1', name: 'Candidate 1', description: '', baseBusinessRoleId: null, members: new Set(['i:b', 'i:a']), entitlements: new Set(['r2', 'r1']) }],
  ...over,
});

describe('viewToSave / viewFromSaved', () => {
  it('turns a filter’s ticked Set into a sorted list and drops a cleared filter', () => {
    const view = { ...DEFAULTS, filters: { activity: { values: new Set(['b', 'a']), includeProposed: false }, duty: null }, extra: 'not saved' };
    expect(viewToSave(view)).toEqual({ ...DEFAULTS, filters: { activity: { values: ['a', 'b'], includeProposed: false } } });
  });

  it('lays a saved view over the defaults, with Sets again', () => {
    const view = viewFromSaved({ columns: ['displayName', 'activity'], filters: { activity: { values: ['a'] } }, includeChildren: false }, DEFAULTS);
    expect(view.columns).toEqual(['displayName', 'activity']);
    expect(view.includeChildren).toBe(false);
    expect(view.filters.activity.values).toEqual(new Set(['a']));
    expect(view.groupBy).toBe('none');
  });

  it('drops columns and filters the workbench no longer has, and falls back to the default columns', () => {
    const view = viewFromSaved({ columns: ['gone'], filters: { gone: { values: ['x'] }, activity: { values: 'not a list' } } }, DEFAULTS);
    expect(view.columns).toEqual(DEFAULT_COLUMNS);
    expect(view.filters).toEqual({});
    expect(viewFromSaved(null, DEFAULTS)).toEqual(DEFAULTS);
  });

  it('round-trips', () => {
    const view = { ...DEFAULTS, columns: ['displayName', 'duty'], filters: { duty: { values: new Set(['OR']) } }, sort: { key: 'name', dir: 'desc' } };
    expect(viewFromSaved(JSON.parse(JSON.stringify(viewToSave(view))), DEFAULTS)).toEqual(view);
  });
});

describe('accessCellsOf', () => {
  it('keeps only held cells with a grant type the API knows', () => {
    expect(accessCellsOf([
      { person: 'i:a', resourceId: 'r1', type: 'Direct' },
      { person: 'p:x', resourceId: 'r2', type: 'Eligible' },
      { person: 'i:b', resourceId: 'r1', type: null },
    ])).toEqual(['i:a|r1|Direct', 'p:x|r2|Eligible']);
    expect(accessCellsOf(undefined)).toEqual([]);
  });
});

describe('toSavePayload', () => {
  const data = { generatedAt: '2026-10-27T09:00:00.000Z', cells: [{ person: 'i:a', resourceId: 'r1', type: 'Indirect' }] };

  it('sends the view, the access on screen, every mark and every proposed role — never the selection', () => {
    const body = toSavePayload({ view: DEFAULTS, data, draft: draftState(), name: 'Motor' });
    expect(body).toEqual({
      name: 'Motor',
      view: DEFAULTS,
      accessReadAt: '2026-10-27T09:00:00.000Z',
      accessCells: ['i:a|r1|Indirect'],
      marks: [{ person: 'i:a', resourceId: 'r2', mark: 'investigate' }, { person: 'i:b', resourceId: 'or', mark: 'other' }],
      proposals: [{ id: 'draft:1', name: 'Candidate 1', description: null, baseBusinessRoleId: null, members: ['i:a', 'i:b'], entitlements: ['r1', 'r2'], ...UNSET }],
    });
  });

  it('sends the time it was opened at on a save over it, and no name', () => {
    const body = toSavePayload({ view: DEFAULTS, data: null, draft: draftState({ drafts: [] }), expectedUpdatedAt: '2026-10-27T10:00:00.000Z' });
    expect(body).toMatchObject({ expectedUpdatedAt: '2026-10-27T10:00:00.000Z', accessReadAt: null, accessCells: [], proposals: [] });
    expect('name' in body).toBe(false);
  });
});

// How a proposed role is assigned, when nothing was chosen (migration 108's defaults).
const UNSET = { kind: null, rule: null, excluded: [], joinerPolicy: 'auto', leaverPolicy: 'remove', approver: null, rationale: null };

describe('saving how a proposed role is assigned', () => {
  it('sends the kind, the rule (its values a sorted list), the exceptions, the policies, the approver and the why — and reads them back', () => {
    const draft = {
      marks: new Map(), drafts: [{
        id: 'draft:2', name: 'Lawyer', description: '', baseBusinessRoleId: null, members: new Set(['i:b']), entitlements: new Set(['r1']),
        kind: 'requestable', rule: { includeChildren: false, filters: { jobTitle: { values: new Set(['Z', 'A']), includeProposed: true, contains: ['law'] } } },
        excluded: new Set(['i:c']), joinerPolicy: 'approval', leaverPolicy: 'review', approver: { kind: 'accountable' }, rationale: 'Lawyers need it',
      }],
    };
    const [p] = toSavePayload({ view: { filters: {} }, data: null, draft }).proposals;
    expect(p).toMatchObject({
      kind: 'requestable', rule: { includeChildren: false, filters: { jobTitle: { values: ['A', 'Z'], includeProposed: true, contains: ['law'] } } },
      excluded: ['i:c'], joinerPolicy: 'approval', leaverPolicy: 'review', approver: { kind: 'accountable' }, rationale: 'Lawyers need it',
    });
    const [back] = draftFromSaved({ proposals: [{ ...p, id: SAVED_ID, rule: { filters: { ...p.rule.filters, gone: { values: ['x'] } } } }] }).drafts;
    expect(back.rule).toEqual({ includeChildren: true, filters: { jobTitle: { values: new Set(['A', 'Z']), includeProposed: true, contains: ['law'] } } });
    expect(back.excluded).toEqual(new Set(['i:c']));
    expect(back).toMatchObject({ kind: 'requestable', joinerPolicy: 'approval', leaverPolicy: 'review', approver: { kind: 'accountable' }, rationale: 'Lawyers need it' });
  });
});

describe('draftFromSaved', () => {
  it('gives back marks by cell and the proposed roles with Sets', () => {
    const { marks, drafts } = draftFromSaved({
      marks: [{ person: 'p:x', resourceId: 'r1', mark: 'unrelated' }],
      proposals: [{ id: SAVED_ID, name: 'Motor', description: null, baseBusinessRoleId: 'br', members: ['i:a'], entitlements: ['r1'] }],
    });
    expect(marks).toEqual(new Map([['p:x|r1', 'unrelated']]));
    expect(drafts).toEqual([{ id: SAVED_ID, name: 'Motor', description: '', baseBusinessRoleId: 'br', members: new Set(['i:a']), entitlements: new Set(['r1']),
      kind: null, rule: null, excluded: new Set(), joinerPolicy: 'auto', leaverPolicy: 'remove', approver: null, rationale: '' }]);
    expect(draftFromSaved({})).toEqual({ marks: new Map(), drafts: [] });
  });
});

describe('fingerprint', () => {
  it('ignores the selection and the open proposed role, but not a mark, a member or the view', () => {
    const base = fingerprint(DEFAULTS, draftState());
    expect(fingerprint(DEFAULTS, draftState({ selection: new Set(), activeId: null }))).toBe(base);
    expect(fingerprint(DEFAULTS, draftState({ marks: new Map() }))).not.toBe(base);
    const more = draftState();
    more.drafts[0].members.add('i:c');
    expect(fingerprint(DEFAULTS, more)).not.toBe(base);
    expect(fingerprint({ ...DEFAULTS, includeChildren: false }, draftState())).not.toBe(base);
  });

  it('does not see a new draft’s handle become its saved id as a change', () => {
    const unsaved = draftState();
    const saved = draftState();
    saved.drafts[0] = { ...saved.drafts[0], id: SAVED_ID };
    expect(fingerprint(DEFAULTS, saved)).not.toBe(fingerprint(DEFAULTS, unsaved));
    const handle = draftState();
    handle.drafts[0] = { ...handle.drafts[0], id: 'draft:7' };
    expect(fingerprint(DEFAULTS, handle)).toBe(fingerprint(DEFAULTS, unsaved));
  });
});

describe('statusText', () => {
  const saved = { name: 'Motor', updatedBy: 'ann', updatedAt: '2026-10-27T09:00:00.000Z' };
  it('says whether there is work, whether it is saved, and as what', () => {
    expect(statusText({ saved: null, dirty: false })).toBe('Nothing to save yet');
    expect(statusText({ saved: null, dirty: true })).toBe('Not saved — this work lives in this tab only');
    expect(statusText({ saved, dirty: true })).toBe('Unsaved changes to “Motor”');
    expect(statusText({ saved, dirty: false })).toBe(`Saved as “Motor” · ann, ${new Date(saved.updatedAt).toLocaleString()}`);
  });
});

describe('accessChanges', () => {
  it('counts cells gone, new, and held another way', () => {
    const before = ['i:a|r1|Direct', 'i:a|r2|Direct', 'i:b|r1|Eligible'];
    const now = [
      { person: 'i:a', resourceId: 'r1', type: 'Direct' }, // same
      { person: 'i:b', resourceId: 'r1', type: 'Direct' }, // another way
      { person: 'i:c', resourceId: 'r1', type: 'Indirect' }, // new
    ]; // i:a|r2 gone
    expect(accessChanges(before, now)).toBe(3);
    expect(accessChanges(before, before.map(c => { const [p, r, type] = c.split('|'); return { person: p, resourceId: r, type }; }))).toBe(0);
    expect(accessChanges(undefined, [])).toBe(0);
  });
});

describe('defaultInvestigationName', () => {
  it('suggests "<unit> — dd-mm-yyyy"', () => {
    expect(defaultInvestigationName('Property Claims', new Date(2026, 9, 7))).toBe('Property Claims — 07-10-2026');
  });
});
