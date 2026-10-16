import { describe, it, expect } from 'vitest';
import { canvasBoxes, placeBoxes, boxHeight, HEADER_H, ROW_H, BLOCK_H, BOX_W } from './modelCanvas';
import { enrichmentBlocks, withEnrichmentBlocks, endBoxId, loopPath, activityLabel, templateEdges } from './templateCanvas';

const CUSTOMERS = {
  id: 'p1', name: 'Contoso customers',
  recipe: { entities: [{ type: 'Klant', nameColumn: 'Name', attributes: [{ column: 'Owner', name: 'owner' }] }] },
  linkRules: [],
};
const EXPERTISE = {
  id: 'p2', name: 'Expertise list',
  recipe: { template: 'enrichment', enrich: { targetType: 'Identity' },
    entities: [{ type: 'Maten', nameColumn: 'Name', attributes: [{ column: 'Exp', name: 'expertises', multi: true }] }] },
  linkRules: [{ entityType: 'Maten', targetType: 'Identity', via: 'displayName', signals: [] }],
};
const HOURS = { id: 'p3', name: 'Hours', recipe: { template: 'activity', activity: { type: 'Uren' } }, linkRules: [] };
const SOD = { id: 'p4', name: 'SoD', recipe: { template: 'relation', relation: { type: 'Incompatibility', predicate: 'incompatibleWith' } }, linkRules: [] };

const MODEL = {
  entityTypes: [
    { type: 'Klant', template: 'collection', count: 40 },
    { type: 'Maten', template: 'enrichment', count: 30 },
    { type: 'Incompatibility', template: 'relation', count: 12 },
    { type: 'Asset', count: 2 },
  ],
  profiles: [CUSTOMERS, EXPERTISE, HOURS, SOD],
  enrichments: [
    { type: 'Maten', targetType: 'Identity', profileName: 'Expertise list', attributes: [{ name: 'expertises', multi: true }, { name: 'level' }] },
    { type: 'Badges', targetType: 'Principal', profileName: 'Badge list', attributes: [{ name: 'badge' }] },
  ],
  activities: [{ type: 'Uren', profileName: 'Hours', actorTypes: ['Principal', 'Identity'], subjectType: 'OrgEntity', subjectEntityType: 'Klant', rows: 1152, unit: 'h' }],
  pairs: [
    { type: 'Incompatibility', predicate: 'incompatibleWith', leftType: 'Resource', rightType: 'Resource', count: 12, profileName: 'SoD' },
    { type: 'Covers', predicate: 'covers', leftType: 'Klant', rightType: 'Asset', count: 3 },
  ],
};

describe('only collection types are cards', () => {
  it('draws no card for an enrichment, activity or relation type, with or without a template on the type', () => {
    const entities = canvasBoxes(MODEL).filter(b => b.kind === 'entity').map(b => b.title);
    expect(entities).toEqual(['Klant', 'Asset']);
    // The type row lost its template: the enrichment profile still keeps it off the canvas.
    const untyped = { ...MODEL, entityTypes: MODEL.entityTypes.map(({ template: _t, ...t }) => t) };
    expect(canvasBoxes(untyped).filter(b => b.kind === 'entity').map(b => b.title)).toEqual(['Klant', 'Asset']);
  });

  it('keeps an entity type with an explicit collection template and one without a template', () => {
    const boxes = canvasBoxes({ entityTypes: [{ type: 'Zone', template: 'collection' }, { type: 'Area' }, { type: 'Log', template: 'activity' }] });
    expect(boxes.filter(b => b.kind === 'entity').map(b => b.title)).toEqual(['Area', 'Zone']);
  });
});

describe('enrichment blocks', () => {
  it('builds one block per enrichment of the target, its attributes joined and multi ones marked', () => {
    expect(enrichmentBlocks(MODEL.enrichments, 'Identity')).toEqual([
      { id: 'x:Expertise list', label: '+ expertises (multiple) · level', source: 'Maten', owner: 'Expertise list' },
    ]);
    expect(enrichmentBlocks(MODEL.enrichments, 'Resource')).toEqual([]);
    expect(enrichmentBlocks(null, 'Identity')).toEqual([]);
  });

  it('attaches each block to its own system card only, and makes that card taller', () => {
    const boxes = withEnrichmentBlocks(canvasBoxes(MODEL), MODEL.enrichments);
    const blocksOf = (id) => boxes.find(b => b.id === id).blocks;
    expect(blocksOf('s:Identity').map(k => k.source)).toEqual(['Maten']);
    expect(blocksOf('s:Principal').map(k => k.source)).toEqual(['Badges']);
    expect(blocksOf('s:Resource')).toEqual([]);
    expect(boxes.find(b => b.id === 'e:Klant').blocks).toBeUndefined();
    const identity = boxes.find(b => b.id === 's:Identity');
    expect(boxHeight(identity)).toBe(HEADER_H + 3 * ROW_H + BLOCK_H);
  });

  it('places a block under the card\'s rows', () => {
    const boxes = withEnrichmentBlocks(canvasBoxes(MODEL), MODEL.enrichments).filter(b => b.id === 's:Identity');
    const [placed] = placeBoxes(boxes, { 's:Identity': { x: 100, y: 50 } });
    expect(placed.blocks[0]).toMatchObject({ x: 100, y: 50 + HEADER_H + 3 * ROW_H, source: 'Maten' });
  });
});

describe('endBoxId / loopPath / activityLabel', () => {
  const boxes = new Map([['s:Resource', {}], ['e:Klant', {}]]);
  it('resolves an end to a system card when one exists, else to the collection card', () => {
    expect(endBoxId('Resource', undefined, boxes)).toBe('s:Resource');
    expect(endBoxId('OrgEntity', 'Klant', boxes)).toBe('e:Klant');
    expect(endBoxId('Klant', undefined, boxes)).toBe('e:Klant');
  });

  it('draws a loop to the right of the header, each next loop wider', () => {
    const box = { x: 10, y: 20, w: BOX_W };
    expect(loopPath(box).path).toBe(`M 210 28 C 258 4 258 80 210 56`);
    expect(loopPath(box, 1).path).toBe(`M 210 28 C 276 4 276 80 210 56`);
    expect(loopPath(box).mid).toEqual({ x: 246, y: 42 });
  });

  it('labels an activity with its type, row count and unit', () => {
    expect(activityLabel({ type: 'Uren', rows: 1152, unit: 'h' })).toBe('Uren · 1,152 rows · h');
    expect(activityLabel({ type: 'Log', rows: 1 })).toBe('Log · 1 row');
  });
});

describe('templateEdges', () => {
  const positions = {
    'e:Klant': { x: 0, y: 0 }, 'e:Asset': { x: 0, y: 300 },
    's:Principal': { x: 400, y: 0 }, 's:Identity': { x: 400, y: 200 }, 's:Resource': { x: 400, y: 400 }, 's:Context': { x: 400, y: 600 },
  };
  const placed = placeBoxes(canvasBoxes(MODEL), positions);
  const edges = templateEdges(placed, MODEL);
  const byKey = (k) => edges.find(e => e.key === k);

  it('draws the activity from the first actor system card on the canvas to the subject card', () => {
    const a = byKey('a:Hours');
    expect(a).toMatchObject({ kind: 'activity', owners: ['Hours'], label: 'Uren · 1,152 rows · h' });
    // From Account (s:Principal, header middle y=22) leftwards into Klant (header middle y=22).
    expect(a.path).toBe('M 400 22 C 300 22 300 22 200 22');
  });

  it('draws a relation between two resources as a loop on the resource card, and one between two types as an edge', () => {
    expect(byKey('r:Incompatibility:incompatibleWith')).toMatchObject({ kind: 'relation', label: 'incompatibleWith 12', owners: ['SoD'] });
    expect(byKey('r:Incompatibility:incompatibleWith').path).toBe('M 600 408 C 648 384 648 460 600 436');
    expect(byKey('r:Covers:covers').path).toMatch(/^M 200 22 C /);
  });

  it('leaves out an edge whose end is not on the canvas', () => {
    const lone = templateEdges(placed, { activities: [{ type: 'X', actorTypes: ['Nobody'], subjectType: 'OrgEntity', subjectEntityType: 'Klant' }], pairs: [{ type: 'Y', predicate: 'p', leftType: 'Gone', rightType: 'Klant' }] });
    expect(lone).toEqual([]);
    expect(templateEdges(placed, null)).toEqual([]);
  });
});
