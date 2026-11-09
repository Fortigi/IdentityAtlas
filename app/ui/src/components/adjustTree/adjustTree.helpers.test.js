import { describe, it, expect } from 'vitest';
import {
  TOP_LEVEL_DROP_ID, buildTree, initialOpen, indexUnits, subtreeIds, ancestorIds, resolveDrop, searchUnits,
  memberWord, memberDetail, holderLabel, holderSuffix, showMembersLabel, isPeopleTree, countText, unitMarks, statusMeta, liveAdjustments,
  adjustmentsForUnit, byLine, sourceText, doneText, addedUnitId, commonParentId, moveTargets, withReason,
  actionAllowed,
} from './adjustTree.helpers';

// A small organisation, listed out of name order so sorting is visible:
//   Board ─┬─ IT
//          └─ Finance ── Accounting
//   Not placed
//   Zeta (its parent is not in the list)
const UNITS = [
  { id: 'it', parentId: 'board', name: 'IT' },
  { id: 'acc', parentId: 'fin', name: 'Accounting' },
  { id: 'np', parentId: null, name: 'Not placed' },
  { id: 'zeta', parentId: 'gone', name: 'Zeta' },
  { id: 'fin', parentId: 'board', name: 'Finance' },
  { id: 'board', parentId: null, name: 'Board' },
];

describe('buildTree', () => {
  it('nests the flat list, siblings by name, an orphan as a root', () => {
    const roots = buildTree(UNITS);
    expect(roots.map(r => r.id)).toEqual(['board', 'np', 'zeta']);
    expect(roots[0].children.map(c => c.id)).toEqual(['fin', 'it']);
    expect(roots[0].children[0].children.map(c => c.id)).toEqual(['acc']);
    expect(roots[1].children).toEqual([]);
  });

  it('treats a unit that names itself as its parent as a root, and copes with no list', () => {
    expect(buildTree([{ id: 'a', parentId: 'a', name: 'A' }]).map(r => r.id)).toEqual(['a']);
    expect(buildTree(undefined)).toEqual([]);
  });

  it('does not change the units it was given', () => {
    const units = [{ id: 'a', parentId: null, name: 'A' }];
    buildTree(units);
    expect(units[0]).toEqual({ id: 'a', parentId: null, name: 'A' });
  });
});

describe('initialOpen', () => {
  it('opens the top level and the level below, not deeper', () => {
    expect([...initialOpen(buildTree(UNITS))].sort()).toEqual(['board', 'fin', 'it', 'np', 'zeta']);
  });
});

describe('subtreeIds / ancestorIds', () => {
  it('collects a unit and everything below it, and nothing beside it', () => {
    expect([...subtreeIds(UNITS, 'board')].sort()).toEqual(['acc', 'board', 'fin', 'it']);
    expect([...subtreeIds(UNITS, 'fin')].sort()).toEqual(['acc', 'fin']);
    expect([...subtreeIds(UNITS, 'acc')]).toEqual(['acc']);
  });

  it('stops on a parent loop instead of running forever', () => {
    const loop = [{ id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }];
    expect([...subtreeIds(loop, 'p')].sort()).toEqual(['p', 'q']);
    expect(ancestorIds(indexUnits(loop), 'p')).toEqual(['q']);
  });

  it('lists the units above, nearest first, and stops at a parent not in the list', () => {
    const byId = indexUnits(UNITS);
    expect(ancestorIds(byId, 'acc')).toEqual(['fin', 'board']);
    expect(ancestorIds(byId, 'board')).toEqual([]);
    expect(ancestorIds(byId, 'zeta')).toEqual([]);
  });
});

describe('resolveDrop', () => {
  const unit = (unitId) => ({ type: 'unit', unitId });

  it('moves a unit under the unit it is dropped on', () => {
    expect(resolveDrop(unit('fin'), 'it', UNITS)).toEqual({ op: 'moveUnit', subjectId: 'fin', toParentId: 'it' });
  });

  it('moves a unit to the top level from the top-level zone', () => {
    expect(resolveDrop(unit('fin'), TOP_LEVEL_DROP_ID, UNITS)).toEqual({ op: 'moveUnit', subjectId: 'fin', toParentId: null });
  });

  it('refuses a drop into the unit\'s own sub-units', () => {
    expect(resolveDrop(unit('board'), 'acc', UNITS)).toEqual({ error: "You can't move a unit into one of its own sub-units." });
  });

  it('changes nothing for a drop on itself, on its own parent, or of a top unit on the top zone', () => {
    expect(resolveDrop(unit('fin'), 'fin', UNITS)).toBeNull();
    expect(resolveDrop(unit('fin'), 'board', UNITS)).toBeNull();
    expect(resolveDrop(unit('board'), TOP_LEVEL_DROP_ID, UNITS)).toBeNull();
  });

  it('moves a member to the unit it is dropped on, and nowhere else', () => {
    const member = { type: 'member', memberId: 'p1', fromUnitId: 'it' };
    expect(resolveDrop(member, 'acc', UNITS)).toEqual({ op: 'moveMember', memberId: 'p1', fromUnitId: 'it', toUnitId: 'acc' });
    expect(resolveDrop(member, 'it', UNITS)).toBeNull();
    expect(resolveDrop(member, TOP_LEVEL_DROP_ID, UNITS)).toBeNull();
  });

  it('ignores an unknown drag, a missing unit or no target', () => {
    expect(resolveDrop(null, 'it', UNITS)).toBeNull();
    expect(resolveDrop(unit('fin'), null, UNITS)).toBeNull();
    expect(resolveDrop({ type: 'file' }, 'it', UNITS)).toBeNull();
    expect(resolveDrop(unit('nope'), 'it', UNITS)).toBeNull();
  });
});

describe('searchUnits', () => {
  it('shows the matches and the units above them, and opens only those above', () => {
    const s = searchUnits(UNITS, 'acc');
    expect([...s.matches]).toEqual(['acc']);
    expect([...s.visible].sort()).toEqual(['acc', 'board', 'fin']);
    expect([...s.open].sort()).toEqual(['board', 'fin']);
  });

  it('ignores case and surrounding spaces', () => {
    expect([...searchUnits(UNITS, '  FIN ').matches]).toEqual(['fin']);
  });

  it('shows everything for an empty query', () => {
    const s = searchUnits(UNITS, '   ');
    expect(s.visible).toBeNull();
    expect(s.open.size).toBe(0);
    expect(s.matches.size).toBe(0);
  });

  it('shows nothing for a query that matches no unit', () => {
    expect(searchUnits(UNITS, 'xyz').visible.size).toBe(0);
  });
});

describe('words', () => {
  it('calls the members of a tree of accounts or identities people', () => {
    expect(memberWord('Principal', 1)).toBe('person');
    expect(memberWord('Principal')).toBe('people');
    expect(memberWord('Identity', 3)).toBe('people');
    expect(memberWord('Resource', 1)).toBe('resource');
    expect(memberWord('Resource', 0)).toBe('resources');
    expect(memberWord('System')).toBe('systems');
    expect(showMembersLabel('Resource')).toBe('Show resources');
    expect(showMembersLabel('Identity')).toBe('Show people');
  });

  it('splits by attribute only in a tree of people', () => {
    expect(isPeopleTree('Principal')).toBe(true);
    expect(isPeopleTree('Identity')).toBe(true);
    expect(isPeopleTree('Resource')).toBe(false);
    expect(isPeopleTree(undefined)).toBe(false);
  });

  it('describes a member by department first, then job title, kind or e-mail', () => {
    expect(memberDetail({ department: 'Finance', jobTitle: 'CFO' })).toBe('Finance');
    expect(memberDetail({ jobTitle: 'CFO', email: 'a@x' })).toBe('CFO');
    expect(memberDetail({ resourceType: 'Group' })).toBe('Group');
    expect(memberDetail({ email: 'a@x' })).toBe('a@x');
    expect(memberDetail({})).toBe('');
  });
});

describe('countText', () => {
  it('shows the total beside the direct count only when they differ', () => {
    expect(countText({ memberCount: 3, totalMemberCount: 10 })).toBe('3 / 10');
    expect(countText({ memberCount: 3, totalMemberCount: 3 })).toBe('3');
    expect(countText({ memberCount: 0, totalMemberCount: 7 })).toBe('0 / 7');
    expect(countText({ memberCount: 4 })).toBe('4');
    expect(countText({})).toBe('0');
  });
});

describe('unitMarks', () => {
  it('marks an adjusted, hand-added, interim unit in that order', () => {
    const marks = unitMarks({ adjusted: true, createdByAdjustment: true, interim: { name: 'Bram', validUntil: '2027-03-31' } });
    expect(marks.map(m => m.key)).toEqual(['adjusted', 'added', 'interim']);
    expect(marks[1].label).toBe('added by hand');
    expect(marks[2].label).toMatch(/^interim until .*2027/);
    expect(marks[2].tone).toBe('warn');
  });

  it('says only "interim" without an end date, and nothing for an untouched unit', () => {
    expect(unitMarks({ interim: { name: 'Bram', validUntil: null } }).map(m => m.label)).toEqual(['interim']);
    expect(unitMarks({ adjusted: false })).toEqual([]);
  });
});

describe('statusMeta', () => {
  it('names every status of the contract', () => {
    expect(['active', 'needsDecision', 'orphaned', 'matches', 'expired', 'reverted'].map(s => statusMeta(s).label))
      .toEqual(['Applied', 'Needs your decision', 'No longer applies', 'Source agrees', 'Expired', 'Undone']);
    expect(statusMeta('orphaned').tone).toBe('bad');
    expect(statusMeta('active').tone).toBe('ok');
  });

  it('shows an unknown status as itself', () => {
    expect(statusMeta('weird')).toEqual({ label: 'weird', tone: 'neutral' });
    expect(statusMeta(undefined).label).toBe('Unknown');
  });
});

describe('adjustments of a unit', () => {
  const ADJ = [
    { id: 1, subjectId: 'fin', status: 'active', payload: {} },
    { id: 2, subjectId: 'it', status: 'active', payload: { toParentId: 'fin' } },
    { id: 3, subjectId: 'fin', status: 'reverted', payload: {} },
    { id: 4, subjectId: 'p1', status: 'orphaned', payload: { toUnitId: 'fin', fromUnitId: 'it' } },
    { id: 5, subjectId: 'new', status: 'active', payload: { parentId: 'fin' } },
    { id: 6, subjectId: 'acc', status: 'active' },
    { id: 7, subjectId: 'board', status: 'active', payload: { contextId: 'staff', name: 'Staff', parentId: 'board' } },
  ];

  it('finds the changes on it and into it, not the undone ones nor the ones elsewhere', () => {
    expect(adjustmentsForUnit(ADJ, 'fin').map(a => a.id)).toEqual([1, 2, 4, 5]);
    // A unit added by hand carries the adjustment that added it.
    expect(adjustmentsForUnit(ADJ, 'staff').map(a => a.id)).toEqual([7]);
    expect(adjustmentsForUnit(ADJ, 'acc').map(a => a.id)).toEqual([6]);
    // Moving a member OUT of a unit is not counted on that unit.
    expect(adjustmentsForUnit(ADJ, 'it').map(a => a.id)).toEqual([2]);
  });

  it('counts the live ones', () => {
    expect(liveAdjustments(ADJ).map(a => a.id)).toEqual([1, 2, 4, 5, 6, 7]);
    expect(liveAdjustments(undefined)).toEqual([]);
  });

  it('says who and when, leaving out what is missing', () => {
    expect(byLine({ createdBy: 'Wim', createdAt: '2026-10-10T08:00:00Z' })).toMatch(/^Wim · .*2026$/);
    expect(byLine({ createdBy: 'Wim' })).toBe('Wim');
    expect(byLine({})).toBe('');
  });
});

describe('sourceText', () => {
  it('says how the tree was made and from which system', () => {
    expect(sourceText({ kind: 'generated', source: { systemName: 'Entra ID' } })).toBe('Generated from Entra ID');
    expect(sourceText({ kind: 'synced', source: { systemName: 'HR' } })).toBe('Imported from HR');
    expect(sourceText({ kind: 'synced', source: {} })).toBe('Imported');
    expect(sourceText({ kind: 'manual', source: { systemName: 'HR' } })).toBe('Built by hand');
    expect(sourceText({ kind: 'other' })).toBe('Tree');
  });
});

describe('doneText', () => {
  it('prefers the API\'s sentence, then the op, then a plain word', () => {
    expect(doneText({ description: 'Move IT under Board' }, 'moveUnit')).toBe('Move IT under Board');
    expect(doneText({}, 'renameUnit')).toBe('Unit renamed');
    expect(doneText(null, 'mystery')).toBe('Saved');
  });
});

describe('addedUnitId', () => {
  const after = [...UNITS, { id: 'new1', parentId: 'board', name: 'Staff' }];

  it('takes the unit the payload names when the tree holds it', () => {
    expect(addedUnitId({ payload: { contextId: 'new1' } }, after, { name: 'Other', parentId: null })).toBe('new1');
  });

  it('never takes the subject, which for addUnit is the parent it went under', () => {
    expect(addedUnitId({ subjectId: 'board', payload: { parentId: 'board' } }, after, { name: 'Staff', parentId: 'board' })).toBe('new1');
  });

  it('else finds the one unit with that name under that parent', () => {
    expect(addedUnitId({ payload: { contextId: 'not-yet-read' } }, after, { name: 'Staff', parentId: 'board' })).toBe('new1');
    expect(addedUnitId({}, after, { name: 'Staff', parentId: null })).toBeNull();
    expect(addedUnitId({}, UNITS, { name: 'Board', parentId: undefined })).toBe('board');
  });

  it('gives up when two units fit', () => {
    const twice = [...after, { id: 'new2', parentId: 'board', name: 'Staff' }];
    expect(addedUnitId({}, twice, { name: 'Staff', parentId: 'board' })).toBeNull();
  });
});

describe('commonParentId', () => {
  it('is the parent every picked unit shares, else the top level', () => {
    expect(commonParentId(UNITS, ['fin', 'it'])).toBe('board');
    expect(commonParentId(UNITS, new Set(['fin', 'acc']))).toBeNull();
    expect(commonParentId(UNITS, ['board', 'np'])).toBeNull();
    expect(commonParentId(UNITS, ['acc'])).toBe('fin');
  });
});

describe('moveTargets', () => {
  it('offers every unit outside its own subtree except its current parent, by name', () => {
    expect(moveTargets(UNITS, 'fin').map(u => u.id)).toEqual(['it', 'np', 'zeta']);
    expect(moveTargets(UNITS, 'board').map(u => u.id)).toEqual(['np', 'zeta']);
  });
});

describe('withReason', () => {
  it('adds a typed reason, trimmed, and nothing for an empty one', () => {
    expect(withReason({ op: 'renameUnit' }, '  HR typo ')).toEqual({ op: 'renameUnit', reason: 'HR typo' });
    expect(withReason({ op: 'renameUnit' }, '   ')).toEqual({ op: 'renameUnit' });
    expect(withReason({ op: 'renameUnit' }, undefined)).toEqual({ op: 'renameUnit' });
  });
});

describe('actionAllowed', () => {
  it('offers every fix to an editor and only "select" to a reader', () => {
    expect(actionAllowed({ type: 'follow' }, true)).toBe(true);
    expect(actionAllowed({ type: 'follow' }, false)).toBe(false);
    expect(actionAllowed({ type: 'select' }, false)).toBe(true);
    expect(actionAllowed(null, true)).toBe(false);
    expect(actionAllowed({}, true)).toBe(false);
  });
});

describe('the Not placed unit', () => {
  // Named to sort first, so only the Not placed rule can put it last.
  const WITH_NP = [...UNITS, { id: 'out', parentId: null, name: 'Aaa not placed', notPlaced: true }];

  it('is listed after the tree', () => {
    expect(buildTree(WITH_NP).map(r => r.id)).toEqual(['board', 'np', 'zeta', 'out']);
  });

  it('takes people, but no units, and is never moved itself', () => {
    expect(resolveDrop({ type: 'unit', unitId: 'fin' }, 'out', WITH_NP)).toEqual({ error: "Units can't be moved into Not placed." });
    expect(resolveDrop({ type: 'member', memberId: 'p1', fromUnitId: 'out' }, 'fin', WITH_NP)).toEqual({ op: 'moveMember', memberId: 'p1', fromUnitId: 'out', toUnitId: 'fin' });
    expect(resolveDrop({ type: 'member', memberId: 'p1', fromUnitId: 'fin' }, 'out', WITH_NP)).toEqual({ op: 'moveMember', memberId: 'p1', fromUnitId: 'fin', toUnitId: 'out' });
    expect(resolveDrop({ type: 'unit', unitId: 'out' }, 'fin', WITH_NP)).toBeNull();
    expect(moveTargets(WITH_NP, 'fin').map(u => u.id)).not.toContain('out');
  });
});

describe('who answers for a unit', () => {
  it('calls the holder of an application its owner, of anything else its manager', () => {
    expect(holderLabel('LogicalApplication')).toBe('Owner');
    expect(holderLabel('OrganizationalUnit')).toBe('Manager');
    expect(holderLabel(null)).toBe('Manager');
  });

  it('shows the holder after the name only when the name does not already carry it', () => {
    expect(holderSuffix({ name: 'Finance (Carl Jansen)', accountable: { name: 'Carl Jansen' } })).toBe('');
    expect(holderSuffix({ name: 'SAP ERP', accountable: { name: 'Clara Dijkstra' } })).toBe('Clara Dijkstra');
    expect(holderSuffix({ name: 'SAP ERP', accountable: null })).toBe('');
  });
});