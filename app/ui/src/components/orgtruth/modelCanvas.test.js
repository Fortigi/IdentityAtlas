import { describe, it, expect } from 'vitest';
import {
  canvasBoxes, ruleEntries, placeBoxes, canvasLines, predicateLines, linePath, targetRowId, boxHeight,
  BOX_W, HEADER_H, ROW_H,
} from './modelCanvas';

const sig = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });

const TS_STAFF = { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Staff', via: 'employee', threshold: 60,
  signals: [sig('employee', 'displayName', 'fuzzy', 100)] };
const OWNER = { entityType: 'Customer', targetType: 'Principal', via: 'owner', signals: [sig('owner', 'email', 'exact', 90)] };
const STAFF_MAIL = { entityType: 'Staff', targetType: 'Identity', via: 'email', signals: [sig('email', 'email', 'exact', 90)] };

const HOURS = {
  id: 'p1', name: 'Contoso hours', version: 3,
  recipe: { entities: [
    { type: 'Timesheet', nameColumn: 'Code', attributes: [{ column: 'c4', name: 'column4' }, { column: 'Who', name: 'employee' }] },
    { type: 'Customer', nameColumn: 'Name', attributes: [{ column: 'Owner', name: 'owner' }] },
  ] },
  linkRules: [OWNER, TS_STAFF],
};
const STAFF = {
  id: 'p2', name: 'Northwind staff', version: 1,
  recipe: { entities: [
    { type: 'Staff', nameColumn: 'Name', attributes: [{ column: 'Mail', name: 'email' }] },
    // A type the first profile already describes stays that profile's card.
    { type: 'Customer', nameColumn: 'Client', attributes: [{ column: 'Region', name: 'region' }] },
  ] },
  linkRules: [STAFF_MAIL],
};
const MODEL = {
  entityTypes: [
    { type: 'Timesheet', count: 900 }, { type: 'Staff', count: 30 }, { type: 'Customer', count: 40 },
    { type: 'Asset', count: 2, attributeKeys: ['serial', 'displayName', 'site'] },
  ],
  systemTypes: [{ targetType: 'Principal', count: 1127 }],
  predicates: [
    { predicate: 'for', fromType: 'Timesheet', toType: 'Customer', count: 870 },
    { predicate: 'self', fromType: 'Staff', toType: 'Staff', count: 3 },
    { predicate: 'gone', fromType: 'Timesheet', toType: 'Nowhere', count: 1 },
  ],
  links: [{ entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 }],
  entityLinks: [{ fromType: 'Timesheet', toType: 'Staff', via: 'employee', accepted: 850, proposed: 12 }],
  profiles: [HOURS, STAFF],
};

describe('canvasBoxes', () => {
  const boxes = canvasBoxes(MODEL);
  const box = (id) => boxes.find(b => b.id === id);

  it('merges the entity types of every profile into one set of cards, each owned by its profile', () => {
    expect(boxes.filter(b => b.kind === 'entity').map(b => [b.title, b.owner, b.profileId, b.own, b.count, b.rows.map(r => r.label).join(',')])).toEqual([
      ['Timesheet', 'Contoso hours', 'p1', true, 900, 'name,column4,employee'],
      ['Customer', 'Contoso hours', 'p1', true, 40, 'name,owner'],
      ['Staff', 'Northwind staff', 'p2', true, 30, 'name,email'],
      ['Asset', null, null, false, 2, 'name,serial,site'],
    ]);
  });

  it('makes every attribute of an owned type a source and its name row an OrgEntity target; a type no list describes is read-only', () => {
    expect(box('e:Staff').rows[1]).toMatchObject({ id: 'e:Staff|email', attribute: 'email', entityType: 'Staff', source: true, target: null });
    expect(box('e:Staff').rows[0].target).toEqual({ targetType: 'OrgEntity', targetEntityType: 'Staff', field: 'displayName' });
    expect(box('e:Asset').rows.map(r => r.source)).toEqual([false, false, false]);
    expect(box('e:Asset').rows[0].target).toEqual({ targetType: 'OrgEntity', targetEntityType: 'Asset', field: 'displayName' });
  });

  it('ends with one card per system target, its fields as target rows and its count when known', () => {
    expect(boxes.filter(b => b.kind === 'system').map(b => [b.id, b.title, b.owner, b.count, b.rows.map(r => r.label).join(',')])).toEqual([
      ['s:Principal', 'Account', null, 1127, 'displayName,email,employeeId'],
      ['s:Identity', 'Person', null, null, 'displayName,email,employeeId'],
      ['s:Resource', 'Group/resource', null, null, 'displayName,mail,externalId'],
      ['s:Context', 'Context', null, null, 'displayName'],
    ]);
    expect(box('s:Resource').rows[1]).toMatchObject({ source: false, target: { targetType: 'Resource', field: 'mail' } });
  });

  it('sorts the types no list describes by name', () => {
    const titles = canvasBoxes({ entityTypes: [{ type: 'Zone' }, { type: 'Asset' }, { type: 'Mailbox' }] })
      .filter(b => b.kind === 'entity').map(b => [b.title, b.count]);
    expect(titles).toEqual([['Asset', 0], ['Mailbox', 0], ['Zone', 0]]);
  });

  it('copes with no model at all', () => {
    expect(canvasBoxes(null).map(b => b.id)).toEqual(['s:Principal', 's:Identity', 's:Resource', 's:Context']);
  });
});

describe('ruleEntries', () => {
  it('lists every rule of every profile with its profile and its index there, a draft replacing the saved list', () => {
    expect(ruleEntries(MODEL.profiles).map(e => [e.key, e.profile, e.index, e.rule.entityType])).toEqual([
      ['Contoso hours#0', 'Contoso hours', 0, 'Customer'],
      ['Contoso hours#1', 'Contoso hours', 1, 'Timesheet'],
      ['Northwind staff#0', 'Northwind staff', 0, 'Staff'],
    ]);
    const drafts = { 'Contoso hours': [TS_STAFF] };
    expect(ruleEntries(MODEL.profiles, drafts).map(e => e.key)).toEqual(['Contoso hours#0', 'Northwind staff#0']);
    expect(ruleEntries(MODEL.profiles, drafts)[0].rule).toBe(TS_STAFF);
    expect(ruleEntries([{ name: 'x' }])).toEqual([]);
    expect(ruleEntries(undefined)).toEqual([]);
  });
});

describe('placeBoxes', () => {
  it('puts each card at its position and gives every row its coordinates', () => {
    const [ts] = placeBoxes(canvasBoxes(MODEL), { 'e:Timesheet': { x: 50, y: 70 } });
    expect(ts).toMatchObject({ x: 50, y: 70, w: BOX_W, h: HEADER_H + 3 * ROW_H });
    expect(ts.rows.map(r => [r.x, r.y, r.cy])).toEqual([[50, 114, 127], [50, 140, 153], [50, 166, 179]]);
    expect(ts.rows[2]).toMatchObject({ boxId: 'e:Timesheet', boxTitle: 'Timesheet' });
  });

  it('puts a card without a position at the origin', () => {
    const placed = placeBoxes(canvasBoxes(MODEL), undefined);
    expect(placed.every(b => b.x === 0 && b.y === 0)).toBe(true);
    expect(boxHeight(placed.find(b => b.id === 's:Context'))).toBe(HEADER_H + ROW_H);
  });
});

describe('linePath', () => {
  const a = { x: 0, w: 100 };
  const b = { x: 300, w: 100 };

  it('leaves the source on the side facing the target and enters the facing side', () => {
    expect(linePath(a, 10, b, 50)).toEqual({ path: 'M 100 10 C 200 10 200 50 300 50', mid: { x: 200, y: 30 } });
    expect(linePath(b, 10, a, 50)).toEqual({ path: 'M 300 10 C 200 10 200 50 100 50', mid: { x: 200, y: 30 } });
  });

  it('keeps a minimum handle for close boxes', () => {
    expect(linePath(a, 0, { x: 120, w: 100 }, 0).path).toBe('M 100 0 C 140 0 80 0 120 0');
    expect(linePath(a, 0, { x: 0, w: 100 }, 20).path).toBe('M 100 0 C 150 0 -50 20 0 20');
  });
});

describe('canvasLines', () => {
  const POS = {
    'e:Timesheet': { x: 0, y: 0 }, 'e:Customer': { x: 0, y: 300 }, 'e:Staff': { x: 600, y: 0 },
    's:Principal': { x: 300, y: 0 }, 's:Identity': { x: 300, y: 200 },
  };
  const placed = placeBoxes(canvasBoxes(MODEL), POS);

  it('draws the rules of both profiles, the cross-list one from Timesheet employee to the Staff name row', () => {
    const lines = canvasLines(placed, ruleEntries(MODEL.profiles), MODEL);
    expect(lines.map(l => [l.key, l.profile, l.index, l.from, l.to])).toEqual([
      ['Contoso hours#0', 'Contoso hours', 0, 'e:Customer|owner', 's:Principal|email'],
      ['Contoso hours#1', 'Contoso hours', 1, 'e:Timesheet|employee', 'e:Staff|displayName'],
      ['Northwind staff#0', 'Northwind staff', 0, 'e:Staff|email', 's:Identity|email'],
    ]);
    const cross = lines[1];
    // Timesheet's employee row (cy 44 + 2·26 + 13 = 109) leaves on its right edge (200);
    // the Staff name row (cy 57) is entered on Staff's left edge (600).
    expect(cross.path).toBe('M 200 109 C 400 109 400 57 600 57');
    expect(cross.label).toBe('fuzzy 100 · 850 accepted · 12 proposed');
    expect(cross.name).toBe('Edit link Timesheet employee to Staff name');
    // Staff sits right of Identity: its line leaves Staff's LEFT edge.
    expect(lines[2].path.startsWith('M 600 83 C')).toBe(true);
    expect(lines[2].path.endsWith('500 283')).toBe(true);
  });

  it('follows a moved card: the same rule ends where the card now is', () => {
    const moved = placeBoxes(canvasBoxes(MODEL), { ...POS, 'e:Staff': { x: -400, y: 100 } });
    const [cross] = canvasLines(moved, [{ key: 'k', profile: 'Contoso hours', index: 1, rule: TS_STAFF }], MODEL);
    expect(cross.path).toBe('M 0 109 C -100 109 -100 157 -200 157');
  });

  it('leaves out a rule it cannot draw', () => {
    const rules = [
      { entityType: 'Customer', targetType: 'Principal', via: 'gone', signals: [] },
      { entityType: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'owner', signals: [] },
      { entityType: 'Customer', targetType: 'Context', via: 'owner', signals: [sig('owner', 'displayName', 'exact', 80)] },
    ].map((rule, index) => ({ key: `p#${index}`, profile: 'p', index, rule }));
    const lines = canvasLines(placed, rules, MODEL);
    expect(lines.map(l => l.index)).toEqual([2]);
    expect(lines[0].label).toBe('exact 80');
  });

  it('staggers two labels that would overlap', () => {
    const rules = ['column4', 'employee'].map((via, index) => ({ key: `p#${index}`, profile: 'p', index,
      rule: { entityType: 'Timesheet', targetType: 'Principal', via, signals: [sig(via, 'displayName', 'exact', 80)] } }));
    const lines = canvasLines(placed, rules, MODEL);
    expect(lines.map(l => l.mid.y)).toEqual([70, 83]);
    // 13 apart, under a label height: the second moves down one step (18).
    expect(lines.map(l => l.labelY)).toEqual([70, 101]);
    expect(lines[0].labelX).toBe(lines[0].mid.x);
  });

  it('names the target row of a rule', () => {
    expect(targetRowId({ targetType: 'OrgEntity', targetEntityType: 'Staff', signals: [] })).toBe('e:Staff|displayName');
    expect(targetRowId({ targetType: 'Resource', signals: [sig('a', 'mail', 'exact', 1)] })).toBe('s:Resource|mail');
  });
});

describe('predicateLines', () => {
  it('draws a relation between two cards header to header, skips a self-relation and an unknown type', () => {
    const placed = placeBoxes(canvasBoxes(MODEL), { 'e:Timesheet': { x: 0, y: 0 }, 'e:Customer': { x: 400, y: 100 } });
    const lines = predicateLines(placed, MODEL);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      key: 'p:Timesheet:for:Customer', owners: ['Contoso hours', 'Contoso hours'], label: 'for 870',
      path: 'M 200 22 C 300 22 300 122 400 122',
    });
    expect(predicateLines(placed, {})).toEqual([]);
  });
});
