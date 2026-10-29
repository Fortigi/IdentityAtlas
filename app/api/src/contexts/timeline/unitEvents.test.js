import { describe, it, expect } from 'vitest';
import {
  actorFor, humanize, membershipEvent, membershipEvents, roleEvents, contextRowEvents, changeRequestEvents,
  adjustmentEvents, adjustmentWords, personAttributeEvents, sortEvents,
} from './unitEvents.js';
import { nameBook } from './unitTimeline.js';

const UNIT = '00000000-0000-4000-8000-000000000001';
const PARENT = '00000000-0000-4000-8000-000000000002';
const OLD_PARENT = '00000000-0000-4000-8000-000000000003';
const LISA = '00000000-0000-4000-8000-0000000000a1';
const MAX = '00000000-0000-4000-8000-0000000000a2';
const SOPHIE = '00000000-0000-4000-8000-0000000000a3';
const TOM = '00000000-0000-4000-8000-0000000000a4';
const BOSS = '00000000-0000-4000-8000-0000000000a5';

const names = nameBook([
  { kind: 'Identity', id: LISA, displayName: 'Lisa Vos' },
  { kind: 'Principal', id: MAX, displayName: 'Max Jacobs' },
  { kind: 'Principal', id: SOPHIE, displayName: 'Sophie Willems' },
  { kind: 'Identity', id: TOM, displayName: 'Tom Bakker' },
  { kind: 'Principal', id: BOSS, displayName: 'Bea Boss' },
  { kind: 'Context', id: PARENT, displayName: 'Claims Handling' },
  { kind: 'Context', id: OLD_PARENT, displayName: 'Northwind' },
]);
const upload = { systemType: 'Upload', systemName: 'Teams.xlsx' };
const deps = { names, provenance: upload };

describe('actorFor — who did it, in words', () => {
  it('names the list, the sync, the rule, the source owner and the analyst', () => {
    expect(actorFor('sync', upload)).toBe('list upload: Teams.xlsx');
    expect(actorFor('sync', { systemType: 'EntraID', systemName: 'Fortigi Entra' })).toBe('Fortigi Entra sync');
    expect(actorFor('sync', {})).toBe('sync');
    expect(actorFor('algorithm', { ruleName: 'Manager hierarchy' })).toBe('rule: Manager hierarchy');
    expect(actorFor('algorithm', {})).toBe('rule');
    expect(actorFor('sourceOwner')).toBe('from the source owner');
    expect(actorFor('analyst', upload)).toBe('analyst');
    expect(actorFor(undefined)).toBeNull();
  });
});

describe('humanize', () => {
  it('turns a column name into words', () => {
    expect(humanize('jobTitle')).toBe('Job title');
    expect(humanize('contextCategory')).toBe('Context category');
  });
});

describe('membership events', () => {
  it('a person joins and leaves, by name, with who did it and a link to them', () => {
    const [joined, left] = membershipEvents([
      { operation: 'I', changedAt: '2026-10-27T09:00:00Z', rowData: { memberType: 'Identity', memberId: LISA, addedBy: 'sync' } },
      { operation: 'D', changedAt: '2026-10-28T09:00:00Z', rowData: { memberType: 'Principal', memberId: MAX, addedBy: 'analyst' } },
    ], deps);
    expect(joined).toMatchObject({ operation: 'added', category: 'people', summary: 'Lisa Vos joined (list upload: Teams.xlsx)', counterpartyKind: 'identity', counterpartyId: LISA });
    expect(joined.burst).toEqual({ key: 'people:joined:list upload: Teams.xlsx', one: 'person joined', many: 'people joined', actor: 'list upload: Teams.xlsx' });
    expect(left).toMatchObject({ operation: 'removed', summary: 'Max Jacobs left (analyst)', counterpartyKind: 'user' });
  });

  it('a resource is added and removed, not "joined"', () => {
    const e = membershipEvent({ at: 't', memberType: 'Resource', memberId: 'x', addedBy: 'algorithm', joined: false }, { names, provenance: {} });
    expect(e.summary).toBe('Someone no longer in the data removed (rule)');
    expect(e.burst.many).toBe('members removed');
  });
});

describe('role events', () => {
  const role = (operation, at, data, prev) => ({ operation, changedAt: at, rowData: data, prevData: prev });

  it('an Accountable taken away and another set within a minute is one change, from → to', () => {
    const out = roleEvents([
      role('D', '2026-10-27T10:00:00Z', { role: 'Accountable', principalId: SOPHIE, addedBy: 'sync' }),
      role('I', '2026-10-27T10:00:30Z', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }),
    ], deps);
    expect(out.map(e => e.summary)).toEqual(['Accountable changed: Sophie Willems → Tom Bakker (analyst)']);
    expect(out[0]).toMatchObject({ category: 'roles', counterpartyKind: 'identity', counterpartyId: TOM });
  });

  it('pairs a removal with the NEXT holder set, never with the set that came before it', () => {
    const out = roleEvents([
      role('I', '2026-10-27T10:00:00.000Z', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }),
      role('D', '2026-10-27T10:00:00.500Z', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }),
      role('I', '2026-10-27T10:00:00.500Z', { role: 'Accountable', identityId: LISA, addedBy: 'analyst' }),
    ], deps);
    expect(out.map(e => e.summary)).toEqual([
      'Accountable set: Tom Bakker (analyst)',
      'Accountable changed: Tom Bakker → Lisa Vos (analyst)',
    ]);
  });

  it('a set before the removal, or of the same holder, is no pair', () => {
    const out = roleEvents([
      role('I', '2026-10-27T10:00:00Z', { role: 'Accountable', identityId: LISA, addedBy: 'analyst' }),
      role('D', '2026-10-27T10:00:10Z', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }),
      role('D', '2026-10-27T11:00:00Z', { role: 'Accountable', identityId: LISA, addedBy: 'analyst' }),
      role('I', '2026-10-27T11:00:05Z', { role: 'Accountable', identityId: LISA, addedBy: 'sync' }),
    ], { names, provenance: {} });
    expect(out.map(e => e.summary)).toEqual([
      'Accountable set: Lisa Vos (analyst)',
      'Accountable removed: Tom Bakker (analyst)',
      'Accountable removed: Lisa Vos (analyst)',
      'Accountable set: Lisa Vos (sync)',
    ]);
  });

  it('far apart they stay two events; Responsible reads added / removed', () => {
    const out = roleEvents([
      role('D', '2026-10-27T10:00:00Z', { role: 'Accountable', principalId: SOPHIE, addedBy: 'sync' }),
      role('I', '2026-10-27T12:00:00Z', { role: 'Accountable', identityId: TOM, addedBy: 'algorithm' }),
      role('I', '2026-10-27T12:00:00Z', { role: 'Responsible', identityId: LISA, addedBy: 'sourceOwner' }),
      role('D', '2026-10-27T13:00:00Z', { role: 'Responsible', identityId: LISA, addedBy: 'analyst', sourceClaimId: 'c1' }),
    ], { names, provenance: {} });
    expect(out.map(e => [e.operation, e.summary])).toEqual([
      ['removed', 'Accountable removed: Sophie Willems (sync)'],
      ['added', 'Accountable set: Tom Bakker (rule)'],
      ['added', 'Responsible added: Lisa Vos (from the source owner)'],
      ['removed', 'Responsible removed: Lisa Vos (from an interview)'],
    ]);
  });

  it('an update that changes the holder is a change; one that changes only who keeps it is none', () => {
    const out = roleEvents([
      role('U', 't1', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }, { role: 'Accountable', principalId: SOPHIE, addedBy: 'analyst' }),
      role('U', 't2', { role: 'Accountable', identityId: TOM, addedBy: 'analyst' }, { role: 'Accountable', identityId: TOM, addedBy: 'sync' }),
    ], deps);
    expect(out.map(e => e.summary)).toEqual(['Accountable changed: Sophie Willems → Tom Bakker (analyst)']);
  });
});

describe('the unit row', () => {
  const update = (prev, data) => ({ operation: 'U', changedAt: 't', prevData: prev, rowData: data });

  it('says renamed, moved (with both parents), description, aliases and other fields in words', () => {
    const out = contextRowEvents([update(
      { displayName: 'Claims', parentContextId: OLD_PARENT, description: null, contextType: 'Team', lastCalculatedAt: 'a', extendedAttributes: { aliases: ['Old'], sector: 'insurance', terms: ['x'] } },
      { displayName: 'Property Claims', parentContextId: PARENT, description: 'Handles property.', contextType: 'Department', lastCalculatedAt: 'b', extendedAttributes: { aliases: ['PC'], sector: 'logistics', terms: ['y'] } },
    )], { names });
    expect(out.map(e => e.summary)).toEqual([
      'Renamed: Claims → Property Claims',
      'Moved under Claims Handling (was under Northwind)',
      'Description changed',
      'Context type: Team → Department',
      'Also known as: PC added',
      'Also known as: Old removed',
      'Sector: insurance → logistics',
    ]);
    expect(out[1]).toMatchObject({ counterpartyKind: 'context', counterpartyId: PARENT });
    expect(out[2].detail).toBe('Handles property.');
  });

  it('a move to the top, creation and deletion', () => {
    const out = contextRowEvents([
      { operation: 'I', changedAt: 't0', rowData: { createdByUser: 'wim' } },
      update({ parentContextId: PARENT }, { parentContextId: null }),
      { operation: 'D', changedAt: 't9', rowData: {} },
    ], { names });
    expect(out.map(e => e.summary)).toEqual(['Unit created (wim)', 'Moved to the top level (was under Claims Handling)', 'Unit deleted']);
  });
});

describe('change requests and tree adjustments', () => {
  it('raised, resolved and withdrawn; a member request is about people', () => {
    const d = { summary: 'Remove Max from Teams.xlsx', targetName: 'Teams.xlsx', memberId: MAX, raisedBy: 'wim' };
    const out = changeRequestEvents([
      { operation: 'I', changedAt: 't1', rowData: { ...d, requestStatus: 'open' } },
      { operation: 'U', changedAt: 't2', prevData: { ...d, requestStatus: 'open' }, rowData: { ...d, requestStatus: 'withdrawn', closedReason: 'decision undone' } },
      { operation: 'U', changedAt: 't3', prevData: { ...d, requestStatus: 'open' }, rowData: { ...d, requestStatus: 'open', summary: 'edited' } },
      { operation: 'U', changedAt: 't4', prevData: { summary: 'Rename', requestStatus: 'open' }, rowData: { summary: 'Rename', requestStatus: 'resolved' } },
    ]);
    expect(out.map(e => [e.category, e.summary])).toEqual([
      ['people', 'Change request raised: Remove Max from Teams.xlsx — to Teams.xlsx (wim)'],
      ['people', 'Change request withdrawn: Remove Max from Teams.xlsx'],
      ['structure', 'Change request resolved: Rename'],
    ]);
    expect(out[1].detail).toBe('decision undone');
  });

  it('what each adjustment did, from this unit\'s side', () => {
    expect(adjustmentWords({ op: 'moveUnit', payload: { toParentId: PARENT } }, UNIT, names)).toBe('moved under Claims Handling');
    expect(adjustmentWords({ op: 'renameUnit', payload: { name: 'PC' } }, UNIT, names)).toBe('renamed to PC');
    expect(adjustmentWords({ op: 'moveMember', memberId: LISA, payload: { toUnitId: UNIT } }, UNIT, names)).toBe('Lisa Vos moved here');
    expect(adjustmentWords({ op: 'moveMember', memberId: MAX, payload: { toUnitId: PARENT } }, UNIT, names)).toBe('Max Jacobs moved to Claims Handling');
    expect(adjustmentWords({ op: 'addUnit', payload: { name: 'Night shift' } }, UNIT, names)).toBe('sub-unit Night shift added');
    expect(adjustmentWords({ op: 'splitUnit', payload: { attribute: 'jobTitle' } }, UNIT, names)).toBe('split by Job title');
    expect(adjustmentWords({ op: 'setManager', payload: { principalId: BOSS } }, UNIT, names)).toBe('manager set to Bea Boss');
  });

  it('an adjustment made, and later undone', () => {
    const d = { op: 'renameUnit', payload: { name: 'PC' }, createdBy: 'gregor', reason: 'HR still has the old name', status: 'active' };
    const out = adjustmentEvents([
      { operation: 'I', changedAt: 't1', rowData: d },
      { operation: 'U', changedAt: 't2', prevData: d, rowData: { ...d, status: 'reverted' } },
      { operation: 'U', changedAt: 't3', prevData: d, rowData: { ...d, updatedAt: 'x' } },
    ], UNIT, { names });
    expect(out.map(e => e.summary)).toEqual(['Tree adjusted: renamed to PC (by gregor)', 'Tree adjustment undone: renamed to PC']);
    expect(out[0].detail).toBe('HR still has the old name');
  });
});

describe('the members\' own changes', () => {
  it('job title, department, manager, disabled, deleted — and nothing for other fields', () => {
    const out = personAttributeEvents([
      { operation: 'U', changedAt: 't', prevData: { id: MAX, displayName: 'Max Jacobs', jobTitle: 'Loss adjuster', department: 'Claims', managerId: SOPHIE, accountEnabled: true, mail: 'a' },
        rowData: { id: MAX, displayName: 'Max Jacobs', jobTitle: 'Senior loss adjuster', department: 'Claims', managerId: BOSS, accountEnabled: false, mail: 'b' } },
      { operation: 'U', changedAt: 't', prevData: { id: SOPHIE, displayName: 'Sophie Willems', deletedAt: null, accountEnabled: false }, rowData: { id: SOPHIE, displayName: 'Sophie Willems', deletedAt: '2026-10-28', accountEnabled: true } },
    ], { names });
    expect(out.map(e => [e.operation, e.summary])).toEqual([
      ['changed', 'Max Jacobs\' job title changed: Loss adjuster → Senior loss adjuster'],
      ['changed', 'Max Jacobs\' manager changed: Sophie Willems → Bea Boss'],
      ['changed', 'Max Jacobs\' account was disabled'],
      ['changed', 'Sophie Willems\' account was enabled again'],
      ['removed', 'Sophie Willems\' account was deleted in the source'],
    ]);
    expect(out[0]).toMatchObject({ category: 'people', counterpartyKind: 'user', counterpartyId: MAX });
  });

  it('a restore reads as one, and a name without a final s gets \'s', () => {
    const [e] = personAttributeEvents([{ operation: 'U', changedAt: 't', prevData: { id: TOM, displayName: 'Tom Bakker', deletedAt: 'x' }, rowData: { id: TOM, displayName: 'Tom Bakker', deletedAt: null } }], { names });
    expect(e).toMatchObject({ operation: 'added', summary: 'Tom Bakker\'s account was restored in the source' });
  });
});

describe('sortEvents', () => {
  it('newest first; an interview event without a category is knowledge', () => {
    const out = sortEvents([
      { at: '2026-10-01T00:00:00Z', summary: 'a', category: 'people' },
      { at: '2026-10-03T00:00:00Z', summary: 'b', eventKind: 'interview' },
      { at: '2026-10-02T00:00:00Z', summary: 'c', category: 'roles' },
    ]);
    expect(out.map(e => [e.summary, e.category])).toEqual([['b', 'knowledge'], ['c', 'roles'], ['a', 'people']]);
  });
});
