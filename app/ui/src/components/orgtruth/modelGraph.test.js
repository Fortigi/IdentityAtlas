import { describe, it, expect } from 'vitest';
import { mermaidText, labelWidth, linkLabel, boxesOverlap, staggerLabels } from './modelGraph';

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

