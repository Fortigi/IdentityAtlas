import { describe, it, expect } from 'vitest';
import { canvasBoxes, layoutCanvas, canvasLines, linePath, targetRowId, BOX_W, HEADER_H, ROW_H } from './modelCanvas';

const PROFILE = {
  id: 'p1', name: 'Contoso hours', version: 3,
  recipe: {
    entities: [
      { type: 'Timesheet', nameColumn: 'Code', attributes: [{ column: 'c4', name: 'column4' }, { column: 'Who', name: 'employee' }] },
      { type: 'Customer', nameColumn: 'Name', attributes: [{ column: 'Owner', name: 'owner' }] },
    ],
  },
};
const MODEL = {
  entityTypes: [{ type: 'Timesheet', count: 900 }, { type: 'Staff', count: 30 }, { type: 'Customer', count: 40 }, { type: 'Asset', count: 2 }],
  systemTypes: [{ targetType: 'Principal', count: 1127 }],
  links: [{ entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 }],
  entityLinks: [{ fromType: 'Timesheet', toType: 'Customer', via: 'column4', accepted: 850, proposed: 12 }],
};
const sig = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });

describe('canvasBoxes', () => {
  const { entities, systems } = canvasBoxes(PROFILE, MODEL);

  it('puts the profile own entity types first with every attribute, then the other lists by name with only their name', () => {
    expect(entities.map(b => [b.title, b.own, b.count, b.rows.map(r => r.label).join(',')])).toEqual([
      ['Timesheet', true, 900, 'name,column4,employee'],
      ['Customer', true, 40, 'name,owner'],
      ['Asset', false, 2, 'name'],
      ['Staff', false, 30, 'name'],
    ]);
  });

  it('makes attribute rows sources of an own box and every name row a target of type OrgEntity', () => {
    const [ts, , asset] = entities;
    expect(ts.rows[1]).toMatchObject({ id: 'e:Timesheet|column4', attribute: 'column4', source: true, target: null });
    expect(ts.rows[0].target).toEqual({ targetType: 'OrgEntity', targetEntityType: 'Timesheet', field: 'displayName' });
    expect(asset.rows[0]).toMatchObject({ source: false, target: { targetType: 'OrgEntity', targetEntityType: 'Asset', field: 'displayName' } });
  });

  it('adds one box per system target with its fields as target rows and its count when known', () => {
    expect(systems.map(b => [b.title, b.count, b.rows.map(r => r.label).join(',')])).toEqual([
      ['Account', 1127, 'displayName,email,employeeId'],
      ['Person', null, 'displayName,email,employeeId'],
      ['Group/resource', null, 'displayName,mail,externalId'],
      ['Context', null, 'displayName'],
    ]);
    expect(systems[2].rows[1]).toMatchObject({ id: 's:Resource|mail', source: false, target: { targetType: 'Resource', field: 'mail' } });
  });

  it('copes with no profile recipe and no model', () => {
    const empty = canvasBoxes(null, null);
    expect(empty.entities).toEqual([]);
    expect(empty.systems).toHaveLength(4);
  });
});

describe('layoutCanvas', () => {
  const layout = layoutCanvas({ ...PROFILE }, { ...MODEL, entityTypes: MODEL.entityTypes.filter(t => t.type !== 'Asset') });
  const box = (id) => layout.boxes.find(b => b.id === id);

  it('centres the entity row over the wider system row, deterministically', () => {
    // 3 entity boxes span 3·200 + 2·96 = 792; 4 system boxes span 1088.
    expect(layout.boxes.filter(b => b.kind === 'entity').map(b => b.x)).toEqual([172, 468, 764]);
    expect(layout.boxes.filter(b => b.kind === 'system').map(b => b.x)).toEqual([24, 320, 616, 912]);
    expect(layout.width).toBe(1136);
  });

  it('puts the system row below the tallest entity box and sizes rows', () => {
    expect(box('e:Timesheet')).toMatchObject({ y: 24, w: BOX_W, h: HEADER_H + 3 * ROW_H });
    expect(box('e:Customer').h).toBe(HEADER_H + 2 * ROW_H);
    expect(box('s:Principal').y).toBe(24 + 110 + 110);
    expect(box('s:Context').h).toBe(HEADER_H + ROW_H);
    expect(layout.height).toBe(244 + 110 + 24);
    expect(box('e:Timesheet').rows.map(r => r.cy)).toEqual([69, 95, 121]);
    expect(box('e:Timesheet').rows[2]).toMatchObject({ boxId: 'e:Timesheet', boxTitle: 'Timesheet', x: 172, y: 108 });
  });

  it('gives an empty canvas only the system row', () => {
    const empty = layoutCanvas(null, null);
    expect(empty.boxes.map(b => b.id)).toEqual(['s:Principal', 's:Identity', 's:Resource', 's:Context']);
    expect(empty.boxes[0].y).toBe(24 + 0 + 110);
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
    const near = { x: 120, w: 100 };
    expect(linePath(a, 0, near, 0).path).toBe('M 100 0 C 140 0 80 0 120 0');
    // centres level: still drawn rightward
    expect(linePath(a, 0, { x: 0, w: 100 }, 20).path).toBe('M 100 0 C 150 0 -50 20 0 20');
  });
});

describe('canvasLines', () => {
  const layout = layoutCanvas(PROFILE, { ...MODEL, entityTypes: MODEL.entityTypes.filter(t => t.type !== 'Asset' && t.type !== 'Staff') });

  it('draws a rule to another list from its attribute row to that list name row, with counts', () => {
    const rule = { entityType: 'Timesheet', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'column4', threshold: 60,
      signals: [sig('column4', 'displayName', 'fuzzy', 100)] };
    const [line] = canvasLines(layout, [rule], MODEL);
    expect(line).toMatchObject({
      index: 0, from: 'e:Timesheet|column4', to: 'e:Customer|displayName',
      label: 'fuzzy 100 · 850 accepted · 12 proposed',
      name: 'Edit link Timesheet column4 to Customer name',
    });
  });

  it('draws a rule to a system field from the side facing it', () => {
    const rule = { entityType: 'Customer', targetType: 'Principal', via: 'owner', signals: [sig('owner', 'email', 'exact', 90)] };
    const [line] = canvasLines(layout, [rule], MODEL);
    const customer = layout.boxes.find(b => b.id === 'e:Customer');
    const principal = layout.boxes.find(b => b.id === 's:Principal');
    expect(customer.x).toBeGreaterThan(principal.x);
    expect(line.to).toBe('s:Principal|email');
    expect(line.path.startsWith(`M ${customer.x} ${customer.rows[1].cy} C`)).toBe(true);
    expect(line.path.endsWith(`${principal.x + BOX_W} ${principal.rows[1].cy}`)).toBe(true);
    expect(line.name).toBe('Edit link Customer owner to Account email');
    expect(line.label).toBe('exact 90 · 30 accepted · 2 proposed');
  });

  it('skips rules it cannot draw but keeps their index for the others', () => {
    const rules = [
      { entityType: 'Staff', targetType: 'Principal', via: 'displayName', signals: [] },                 // not this profile's
      { entityType: 'Customer', targetType: 'Principal', via: 'gone', signals: [] },                     // no such attribute
      { entityType: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Customer', via: 'owner', signals: [] }, // own box
      { entityType: 'Customer', targetType: 'Context', via: 'owner', signals: [sig('owner', 'displayName', 'exact', 80)] },
    ];
    const lines = canvasLines(layout, rules, MODEL);
    expect(lines.map(l => l.index)).toEqual([3]);
    expect(lines[0].label).toBe('exact 80');
  });

  it('staggers two labels that would overlap', () => {
    const rules = ['column4', 'employee'].map(via => ({ entityType: 'Timesheet', targetType: 'Principal', via,
      signals: [sig(via, 'displayName', 'exact', 80)] }));
    const lines = canvasLines(layout, rules, MODEL);
    // mids at y 192 and 205 (13 apart, under a label height): the second moves down 18.
    expect(lines.map(l => l.mid.y)).toEqual([192, 205]);
    expect(lines.map(l => l.labelY)).toEqual([192, 223]);
    expect(lines[0].labelX).toBe(lines[0].mid.x);
    expect(lines[0].name).toBe('Edit link Timesheet column4 to Account displayName');
  });

  it('names the target row of a rule', () => {
    expect(targetRowId({ targetType: 'OrgEntity', targetEntityType: 'Staff', signals: [] })).toBe('e:Staff|displayName');
    expect(targetRowId({ targetType: 'Resource', signals: [sig('a', 'mail', 'exact', 1)] })).toBe('s:Resource|mail');
  });
});
