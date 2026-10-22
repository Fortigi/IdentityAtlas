import { describe, it, expect } from 'vitest';
import {
  treeKinds, contextIdFor, rootName, buildContextRecords, memberValues, buildMemberRecords,
  buildResponsibleRows, buildLinkRows, keptRecord,
} from './records.js';
import { deterministicGuid } from '../../ingest/normalization.js';
import { ROOT_KEY } from './plan.js';

const unit = (key, over = {}) => ({ key, name: `Name ${key}`, owner: null, responsibles: [], parentKey: null, attributes: {}, members: {}, firstRow: 1, ...over });
const mapping = (over = {}) => ({
  template: 'OrganizationalUnit', listName: 'Klanten', keyColumn: 'Code',
  memberColumns: [{ column: 'Leden', kind: 'Principal' }, { column: 'Apps', kind: 'Resource' }], ...over,
});

describe('treeKinds', () => {
  it('one tree per member kind, in mapping order, without repeats', () => {
    expect(treeKinds(mapping({ memberColumns: [{ kind: 'Resource' }, { kind: 'Principal' }, { kind: 'Resource' }] }))).toEqual(['Resource', 'Principal']);
  });

  it('without member columns: people for organisation units, resources for applications', () => {
    expect(treeKinds(mapping({ memberColumns: [] }))).toEqual(['Identity']);
    expect(treeKinds(mapping({ memberColumns: [], template: 'LogicalApplication' }))).toEqual(['Resource']);
  });
});

describe('contextIdFor', () => {
  it('is the ingest\'s deterministic id, stable per (list, tree, key) and different across each', () => {
    expect(contextIdFor(7, 'Principal', 'K1')).toBe(deterministicGuid('upload-7-Principal', 'K1'));
    expect(contextIdFor(7, 'Principal', 'K1')).toBe(contextIdFor(7, 'Principal', 'K1'));
    const others = [contextIdFor(8, 'Principal', 'K1'), contextIdFor(7, 'Resource', 'K1'), contextIdFor(7, 'Principal', 'K2')];
    expect(new Set([contextIdFor(7, 'Principal', 'K1'), ...others]).size).toBe(4);
  });
});

describe('buildContextRecords', () => {
  const units = [unit('K1', { owner: 'o@x.nl', attributes: { Sector: 'Zorg' } }), unit('K2', { parentKey: 'K1' })];
  const records = buildContextRecords(units, mapping(), 7);

  it('writes a root and every unit per tree, all synced contexts of the list\'s system', () => {
    expect(records).toHaveLength(6);
    expect(records.every(r => r.variant === 'synced' && r.scopeSystemId === 7 && r.contextType === 'OrgUnit')).toBe(true);
    expect(records.filter(r => r.externalId === ROOT_KEY).map(r => r.displayName)).toEqual(['Klanten', 'Klanten · Resources']);
  });

  it('hangs a unit under the root, or under its parent in the SAME tree', () => {
    const byKey = (kind, key) => records.find(r => r.targetType === kind && r.externalId === key);
    expect(byKey('Principal', 'K1').parentContextId).toBe(byKey('Principal', ROOT_KEY).id);
    expect(byKey('Principal', 'K2').parentContextId).toBe(byKey('Principal', 'K1').id);
    expect(byKey('Resource', 'K2').parentContextId).toBe(byKey('Resource', 'K1').id);
  });

  it('carries the owner and the attributes; a unit without attributes gets null, not {}', () => {
    const k1 = records.find(r => r.externalId === 'K1' && r.targetType === 'Principal');
    expect(k1).toMatchObject({ ownerUserId: 'o@x.nl', extendedAttributes: { Sector: 'Zorg' }, displayName: 'Name K1' });
    expect(records.find(r => r.externalId === 'K2').extendedAttributes).toBeNull();
    expect(records.find(r => r.externalId === ROOT_KEY).ownerUserId).toBeNull();
  });

  it('an application list writes LogicalApplication contexts', () => {
    expect(buildContextRecords([unit('A')], mapping({ template: 'LogicalApplication' }), 1)[0].contextType).toBe('LogicalApplication');
  });

  it('rootName names the second tree by its kind', () => {
    expect(rootName('Klanten', 'Identity', 1)).toBe('Klanten · People');
    expect(rootName('Klanten', 'Identity', 0)).toBe('Klanten');
  });
});

describe('members, Responsibles and links', () => {
  const units = [
    unit('K1', { members: { Principal: ['a', 'b', 'a2'], Resource: ['g'] }, responsibles: ['r', 'nobody'] }),
    unit('K2', { members: { Principal: ['b'] } }),
  ];

  it('memberValues lists each distinct value once per kind', () => {
    expect(memberValues(units)).toEqual({ Principal: ['a', 'b', 'a2'], Resource: ['g'] });
  });

  it('writes one membership per matched value, deduplicated when two values are one account', () => {
    const ids = { Principal: new Map([['a', 'P1'], ['a2', 'P1'], ['b', 'P2']]), Resource: new Map([['g', 'R1']]) };
    const recs = buildMemberRecords(units, mapping(), 7, ids);
    const k1 = contextIdFor(7, 'Principal', 'K1');
    expect(recs).toEqual([
      { contextId: k1, memberId: 'P1', memberType: 'Principal', addedBy: 'sync' },
      { contextId: k1, memberId: 'P2', memberType: 'Principal', addedBy: 'sync' },
      { contextId: contextIdFor(7, 'Principal', 'K2'), memberId: 'P2', memberType: 'Principal', addedBy: 'sync' },
      { contextId: contextIdFor(7, 'Resource', 'K1'), memberId: 'R1', memberType: 'Resource', addedBy: 'sync' },
    ]);
  });

  it('a kind without matches writes no memberships', () => {
    expect(buildMemberRecords(units, mapping(), 7, {})).toEqual([]);
  });

  it('a matched Responsible is a role on the unit in every tree; an unmatched one is dropped', () => {
    const rows = buildResponsibleRows(units, mapping(), 7, new Map([['r', 'P9']]));
    expect(rows).toEqual([
      { contextId: contextIdFor(7, 'Principal', 'K1'), role: 'Responsible', holderCol: 'principalId', holderId: 'P9' },
      { contextId: contextIdFor(7, 'Resource', 'K1'), role: 'Responsible', holderCol: 'principalId', holderId: 'P9' },
    ]);
  });

  it('links the two trees key by key, roots included; one tree has no links', () => {
    const links = buildLinkRows(units, mapping(), 7);
    expect(links.map(l => [l.contextId, l.relatedContextId])).toEqual(
      [ROOT_KEY, 'K1', 'K2'].map(k => [contextIdFor(7, 'Principal', k), contextIdFor(7, 'Resource', k)]));
    expect(links.every(l => l.relationshipType === 'SameUnitAs')).toBe(true);
    expect(buildLinkRows(units, mapping({ memberColumns: [{ kind: 'Principal' }] }), 7)).toEqual([]);
  });
});

describe('keptRecord', () => {
  it('writes a stored context back as it is, owned by the list', () => {
    const row = { id: 'c1', externalId: 'K9', displayName: 'Old', targetType: 'Principal', contextType: 'OrgUnit', parentContextId: 'p', ownerUserId: 'o', extendedAttributes: { a: 1 } };
    expect(keptRecord(row, 7)).toEqual({ ...row, variant: 'synced', scopeSystemId: 7 });
    expect(keptRecord({ ...row, parentContextId: undefined, ownerUserId: undefined, extendedAttributes: undefined }, 7))
      .toMatchObject({ parentContextId: null, ownerUserId: null, extendedAttributes: null });
  });
});
