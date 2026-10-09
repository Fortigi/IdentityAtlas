import { describe, it, expect } from 'vitest';
import {
  layoutModel, mermaidText, nodeWidth, sortByCount, NODE_H, LABEL_H,
  labelWidth, linkLabel, boxesOverlap, staggerLabels, placeEdgeLabels,
} from './modelGraph';

const MODEL = {
  entityTypes: [
    { type: 'Person', count: 60, proposed: 2, attributeKeys: ['email'], sources: 1 },
    { type: 'Project', count: 87, proposed: 0, attributeKeys: ['budget', 'costCenter'], sources: 2 },
    { type: 'Asset', count: 60, proposed: 0, attributeKeys: [], sources: 1 },
  ],
  predicates: [
    { predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85 },
    { predicate: 'partOf', fromType: 'Asset', toType: 'Project', count: 12 },
    { predicate: 'manages', fromType: 'Person', toType: 'Person', count: 3 },
  ],
  links: [
    { entityType: 'Person', targetType: 'Principal', via: 'displayName', accepted: 51, proposed: 9 },
    { entityType: 'Asset', targetType: 'Resource', via: 'displayName', accepted: 20, proposed: 0 },
    { entityType: 'Person', targetType: 'Identity', via: 'displayName', accepted: 5, proposed: 1 },
  ],
  systemTypes: [
    { targetType: 'Principal', count: 1127 }, { targetType: 'Resource', count: 1385 }, { targetType: 'Identity', count: 900 },
  ],
  totals: { entities: 207, relations: 100, links: 86, sources: 2 },
};

const byId = (layout) => Object.fromEntries(layout.nodes.map(n => [n.id, n]));

describe('nodeWidth', () => {
  it('grows with the label and never drops below the minimum', () => {
    expect(nodeWidth('Project')).toBe(106);
    expect(nodeWidth('Person')).toBe(99);
    expect(nodeWidth('Asset')).toBe(96);
    expect(nodeWidth('A')).toBe(96);
  });
});

describe('layoutModel', () => {
  const layout = layoutModel(MODEL);
  const n = byId(layout);

  it('puts entity types in row 1 by count desc, ties by name', () => {
    const row1 = layout.nodes.filter(x => x.kind === 'entity');
    expect(row1.map(x => x.label)).toEqual(['Project', 'Asset', 'Person']);
    expect(row1.map(x => x.x)).toEqual([48, 202, 346]);
    expect(new Set(row1.map(x => x.y)).size).toBe(1);
  });

  it('puts only the linked system types in row 2, by linked total desc', () => {
    const row2 = layout.nodes.filter(x => x.kind === 'system');
    expect(row2.map(x => [x.label, x.count, x.systemCount])).toEqual([
      ['Principal', 60, 1127], ['Resource', 20, 1385], ['Identity', 6, 900],
    ]);
    expect(row2.map(x => x.x)).toEqual([24, 193, 355]);
    expect(row2[0].y).toBe(n['t:Project'].y + NODE_H + 150);
  });

  it('leaves room above row 1 for the highest arc and sizes the viewBox', () => {
    // owner spans Project→Person (dx 294.5): arc 48 + 0.18·294.5, its peak half of that.
    expect(n['t:Project'].y).toBeCloseTo(24 + (48 + 294.5 * 0.18) / 2 + 18, 6);
    expect(layout.width).toBe(493);
    expect(layout.height).toBeCloseTo(n['t:Project'].y + NODE_H * 2 + 150 + 24, 6);
  });

  it('draws predicates as arcs or loops and links as dashed lines', () => {
    const e = Object.fromEntries(layout.edges.map(x => [x.id, x]));
    expect(layout.edges).toHaveLength(6);
    expect(layout.nodes.some(x => x.label === 'OrgEntity')).toBe(false);
    const top = n['t:Project'].y;
    expect(e['p:Project:owner:Person']).toMatchObject({ kind: 'predicate', label: 'owner 85', labelX: (101 + 395.5) / 2 });
    expect(e['p:Project:owner:Person'].path).toBe(`M 101 ${top} Q 248.25 ${top - (48 + 294.5 * 0.18)} 395.5 ${top}`);
    expect(e['p:Person:manages:Person'].path).toMatch(/^M [\d.]+ [\d.]+ C /);
    // Person has two system links: they leave its bottom edge at 1/3 and 2/3 of its width.
    expect(e['l:Person:Principal:displayName']).toMatchObject({
      kind: 'link', dashed: true, label: 'name: 51 accepted · 9 proposed',
      path: `M 379 ${top + NODE_H} L 84.5 ${n['s:Principal'].y}`,
    });
    expect(e['l:Person:Identity:displayName'].path).toBe(`M 412 ${top + NODE_H} L 412 ${n['s:Identity'].y}`);
    expect(e['l:Asset:Resource:displayName'].path).toBe(`M 250 ${top + NODE_H} L 250 ${n['s:Resource'].y}`);
  });

  it('is deterministic: the input order of entity types does not matter', () => {
    const shuffled = { ...MODEL, entityTypes: [...MODEL.entityTypes].reverse() };
    expect(layoutModel(shuffled).nodes).toEqual(layout.nodes);
    expect(layoutModel(MODEL)).toEqual(layout);
  });

  it('stacks a second predicate between the same pair higher', () => {
    const two = layoutModel({
      entityTypes: [{ type: 'A', count: 2 }, { type: 'B', count: 1 }],
      predicates: [
        { predicate: 'x', fromType: 'A', toType: 'B', count: 1 },
        { predicate: 'y', fromType: 'B', toType: 'A', count: 1 },
        { predicate: 'z', fromType: 'A', toType: 'Gone', count: 1 },
      ],
    });
    expect(two.edges).toHaveLength(2);
    // The arcs peak 13 px apart, closer than a label is high: the second label
    // is staggered one more label height (18) upwards, clear of the first.
    expect(two.edges[0].labelY - two.edges[1].labelY).toBeCloseTo(13 + 18, 6);
    expect(boxesOverlap(
      { x: two.edges[0].labelX, y: two.edges[0].labelY, w: two.edges[0].labelW, h: LABEL_H },
      { x: two.edges[1].labelX, y: two.edges[1].labelY, w: two.edges[1].labelW, h: LABEL_H },
    )).toBe(false);
  });

  it('lays out an empty model as an empty canvas', () => {
    const empty = layoutModel({});
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.width).toBe(144);
    expect(empty.height).toBe(92);
    expect(layoutModel(null).nodes).toEqual([]);
  });
});

describe('links between two lists and per attribute', () => {
  const LISTS = {
    entityTypes: [
      { type: 'Timesheet', count: 900 }, { type: 'Customer', count: 40 }, { type: 'Staff', count: 30 },
    ],
    predicates: [],
    entityLinks: [
      { fromType: 'Timesheet', toType: 'Customer', via: 'column4', accepted: 850, proposed: 12 },
      { fromType: 'Timesheet', toType: 'Staff', via: 'displayName', accepted: 30, proposed: 0 },
    ],
    links: [
      { entityType: 'Customer', targetType: 'Principal', via: 'owner', accepted: 30, proposed: 2 },
      { entityType: 'Customer', targetType: 'Principal', via: 'team', accepted: 70, proposed: 0 },
      { entityType: 'Customer', targetType: 'OrgEntity', via: 'x', accepted: 1, proposed: 0 },
    ],
  };
  const layout = layoutModel(LISTS);
  const e = Object.fromEntries(layout.edges.map(x => [x.id, x]));

  it('draws a link between two lists as a dashed arc between their entity nodes, with no OrgEntity node', () => {
    expect(layout.nodes.map(x => x.id)).toEqual(['t:Timesheet', 't:Customer', 't:Staff', 's:Principal']);
    expect(e['e:Timesheet:column4:Customer']).toMatchObject({
      kind: 'entityLink', dashed: true, from: 't:Timesheet', to: 't:Customer',
      label: 'column4: 850 accepted · 12 proposed',
    });
    expect(e['e:Timesheet:column4:Customer'].path).toMatch(/^M [\d.]+ [\d.]+ Q /);
    expect(e['e:Timesheet:displayName:Staff'].label).toBe('name: 30 accepted');
  });

  it('draws one system line per attribute, each with its own label', () => {
    expect(e['l:Customer:Principal:owner'].label).toBe('owner: 30 accepted · 2 proposed');
    expect(e['l:Customer:Principal:team'].label).toBe('team: 70 accepted');
    expect(e['l:Customer:Principal:owner'].path).not.toBe(e['l:Customer:Principal:team'].path);
    expect(layout.nodes.find(x => x.id === 's:Principal').count).toBe(102);
  });

  it('keeps every label clear of every other label', () => {
    const boxes = layout.edges.map(x => ({ x: x.labelX, y: x.labelY, w: x.labelW, h: LABEL_H }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
    }
    expect(Math.min(...boxes.map(b => b.y - LABEL_H / 2))).toBeGreaterThanOrEqual(4);
  });

  it('exports the links between lists to Mermaid', () => {
    const lines = mermaidText(LISTS).split('\n');
    expect(lines).toContain('  t_Timesheet -.->|"column4: 850 accepted · 12 proposed"| t_Customer');
    expect(lines).toContain('  t_Customer -.->|"team: 70 accepted"| s_Principal');
    expect(lines.some(l => l.includes('OrgEntity'))).toBe(false);
  });
});

describe('label helpers', () => {
  it('names the entity itself "name" and leaves out zero proposed', () => {
    expect(linkLabel('displayName', 3, 0)).toBe('name: 3 accepted');
    expect(linkLabel(undefined, '4', '2')).toBe('name: 4 accepted · 2 proposed');
    expect(linkLabel('owner', null, 1)).toBe('owner: 0 accepted · 1 proposed');
    expect(labelWidth('abcd')).toBeCloseTo(4 * 6.2 + 10, 6);
  });

  it('overlap needs an intersection on both axes; touching is not overlapping', () => {
    const a = { x: 0, y: 0, w: 100, h: 16 };
    expect(boxesOverlap(a, { x: 99, y: 15, w: 100, h: 16 })).toBe(true);
    expect(boxesOverlap(a, { x: 100, y: 0, w: 100, h: 16 })).toBe(false);
    expect(boxesOverlap(a, { x: 0, y: 16, w: 100, h: 16 })).toBe(false);
    expect(boxesOverlap(a, { x: -99, y: -15, w: 100, h: 16 })).toBe(true);
    expect(boxesOverlap(a, { x: 150, y: 0, w: 220, h: 16 })).toBe(true);
    expect(boxesOverlap(a, { x: 0, y: 17, w: 10, h: 16 })).toBe(false);
  });

  it('staggers only overlapping labels, in their own direction, past every earlier one', () => {
    const box = (x, y, dir) => ({ x, y, w: 100, h: 16, dir });
    // apart: untouched
    expect(staggerLabels([box(0, 50), box(200, 50)])).toEqual([50, 50]);
    // same spot, downward: moved one step (18)
    expect(staggerLabels([box(0, 50, 1), box(10, 50, 1)])).toEqual([50, 68]);
    // upward direction
    expect(staggerLabels([box(0, 50, -1), box(10, 50, -1)])).toEqual([50, 32]);
    // still overlapping after one step: moved twice
    expect(staggerLabels([box(0, 50, -1), box(10, 55, -1)])).toEqual([50, 19]);
    // the third clears both the first and the shifted second
    expect(staggerLabels([box(0, 50, 1), box(0, 50, 1), box(0, 50, 1)])).toEqual([50, 68, 86]);
    // a custom step
    expect(staggerLabels([box(0, 0, 1), box(0, 0, 1)], 20)).toEqual([0, 20]);
  });

  it('gives up after a bounded number of steps', () => {
    const wall = { x: 0, y: 0, w: 100, h: 100000, dir: 1 };
    expect(staggerLabels([wall, { x: 0, y: 0, w: 10, h: 16, dir: 1 }])[1]).toBe(40 * 18);
  });

  it('puts a label at the midpoint plus the offset along the normal', () => {
    const [placed] = placeEdgeLabels([{ label: 'ab', offset: 8, anchor: { x: 100, y: 50, nx: -0.6, ny: 0.8 } }]);
    expect(placed).toMatchObject({ labelX: 100 - 4.8, labelY: 50 + 6.4, labelW: 2 * 6.2 + 10 });
    const [up, clash] = placeEdgeLabels([
      { label: 'x', offset: 4, anchor: { x: 0, y: 100, nx: 0, ny: -1 } },
      { label: 'y', offset: 4, anchor: { x: 0, y: 100, nx: 0, ny: -1 } },
    ]);
    expect(up.labelY).toBe(96);
    expect(clash.labelY).toBe(96 - 18);
  });
});

describe('mermaidText', () => {
  it('exports the fixture exactly', () => {
    expect(mermaidText(MODEL)).toBe([
      'graph LR',
      '  t_Project["Project (87)"]',
      '  t_Asset["Asset (60)"]',
      '  t_Person["Person (60)"]',
      '  s_Principal[["Principal (1127)"]]',
      '  s_Resource[["Resource (1385)"]]',
      '  s_Identity[["Identity (900)"]]',
      '  t_Project -->|"owner 85"| t_Person',
      '  t_Asset -->|"partOf 12"| t_Project',
      '  t_Person -->|"manages 3"| t_Person',
      '  t_Person -.->|"name: 51 accepted · 9 proposed"| s_Principal',
      '  t_Asset -.->|"name: 20 accepted"| s_Resource',
      '  t_Person -.->|"name: 5 accepted · 1 proposed"| s_Identity',
    ].join('\n'));
  });

  it('escapes quotes and pipes and makes ids safe', () => {
    const text = mermaidText({
      entityTypes: [{ type: 'Data "Domain"|x', count: 1 }],
      predicates: [{ predicate: 'a|b', fromType: 'Data "Domain"|x', toType: 'Data "Domain"|x' }],
      links: [{ entityType: 'Data "Domain"|x', targetType: 'Context', accepted: 1 }],
    });
    expect(text.split('\n')).toEqual([
      'graph LR',
      '  t_Data__Domain__x["Data #quot;Domain#quot;#124;x (1)"]',
      '  s_Context[["Context"]]',
      '  t_Data__Domain__x -->|"a#124;b 0"| t_Data__Domain__x',
      '  t_Data__Domain__x -.->|"name: 1 accepted"| s_Context',
    ]);
    expect(mermaidText(null)).toBe('graph LR');
  });
});

describe('sortByCount', () => {
  const rows = [{ type: 'B', count: 5 }, { type: 'A', count: 5 }, { predicate: 'c', count: 9 }, { type: 'D' }];
  it('sorts desc by default with the name as tiebreak', () => {
    expect(sortByCount(rows).map(r => r.type ?? r.predicate)).toEqual(['c', 'A', 'B', 'D']);
  });
  it('sorts asc on request and never mutates', () => {
    expect(sortByCount(rows, 'asc').map(r => r.type ?? r.predicate)).toEqual(['D', 'A', 'B', 'c']);
    expect(rows[0].type).toBe('B');
    expect(sortByCount(undefined)).toEqual([]);
  });
});
