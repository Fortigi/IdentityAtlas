import { describe, it, expect } from 'vitest';
import { layoutModel, mermaidText, nodeWidth, sortByCount, NODE_H } from './modelGraph';

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
    { entityType: 'Person', targetType: 'Principal', accepted: 51, proposed: 9 },
    { entityType: 'Asset', targetType: 'Resource', accepted: 20, proposed: 0 },
    { entityType: 'Person', targetType: 'Identity', accepted: 5, proposed: 1 },
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
    const top = n['t:Project'].y;
    expect(e['p:Project:owner:Person']).toMatchObject({ kind: 'predicate', label: 'owner 85', labelX: (101 + 395.5) / 2 });
    expect(e['p:Project:owner:Person'].path).toBe(`M 101 ${top} Q 248.25 ${top - (48 + 294.5 * 0.18)} 395.5 ${top}`);
    expect(e['p:Person:manages:Person'].path).toMatch(/^M [\d.]+ [\d.]+ C /);
    expect(e['l:Person:Principal']).toMatchObject({
      kind: 'link', dashed: true, label: '51 accepted · 9 proposed',
      path: `M 395.5 ${top + NODE_H} L 84.5 ${n['s:Principal'].y}`,
    });
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
    expect(two.edges[0].labelY - two.edges[1].labelY).toBeCloseTo(13, 6);
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
      '  t_Person -.->|"51 accepted · 9 proposed"| s_Principal',
      '  t_Asset -.->|"20 accepted · 0 proposed"| s_Resource',
      '  t_Person -.->|"5 accepted · 1 proposed"| s_Identity',
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
      '  t_Data__Domain__x -.->|"1 accepted · 0 proposed"| s_Context',
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
