import { describe, it, expect } from 'vitest';
import {
  buildOrgCondition, selectsEveryEntity, orgConditionText, viasForSide, CHIP_LABEL_LIMIT,
} from './orgCondition';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const VIAS = [
  { name: 'eigenaar', kind: 'direct', targets: ['Principal'], links: 58 },
  { name: 'team', kind: 'direct', targets: ['Identity'], links: 20 },
  { name: 'Uren', kind: 'through', targets: ['Principal'], links: 839 },
];
const draft = (over = {}) => ({
  entityType: 'Klant', attributeKey: '', attributeValues: [], picked: [], uncheckedVias: [], ...over,
});

describe('buildOrgCondition', () => {
  it('needs a kind of entity — a blank or whitespace type is not a condition', () => {
    expect(buildOrgCondition(draft({ entityType: '' }), VIAS)).toEqual({ problem: 'Pick a kind of organisation entity.' });
    expect(buildOrgCondition(draft({ entityType: '   ' }), VIAS).condition).toBeUndefined();
    expect(buildOrgCondition(undefined, VIAS).condition).toBeUndefined();
  });

  it('with nothing else, selects every entity of the type and every link (no optional keys at all)', () => {
    const { condition } = buildOrgCondition(draft({ entityType: ' Klant ' }), VIAS);
    expect(condition).toEqual({ kind: 'org', entityType: 'Klant' });
    expect(selectsEveryEntity(condition)).toBe(true);
  });

  it('carries the attribute with trimmed, de-duplicated values and drops empty ones', () => {
    const { condition } = buildOrgCondition(
      draft({ attributeKey: ' iso27001 ', attributeValues: ['Ja', ' Ja ', '', '  ', 'Nee'] }), VIAS,
    );
    expect(condition).toEqual({ kind: 'org', entityType: 'Klant', attribute: { key: 'iso27001', values: ['Ja', 'Nee'] } });
    expect(selectsEveryEntity(condition)).toBe(false);
  });

  it('refuses an attribute key with no value left — an empty value list would match nothing', () => {
    const r = buildOrgCondition(draft({ attributeKey: 'iso27001', attributeValues: ['', ' '] }), VIAS);
    expect(r).toEqual({ problem: 'Pick at least one value of iso27001, or clear the attribute.' });
  });

  it('ignores values when no attribute key is chosen', () => {
    const { condition } = buildOrgCondition(draft({ attributeValues: ['Ja'] }), VIAS);
    expect(condition).toEqual({ kind: 'org', entityType: 'Klant' });
  });

  it('records the picked entities as ids plus their labels, in pick order', () => {
    const { condition } = buildOrgCondition(draft({
      picked: [{ id: ID_B, label: 'Northwind' }, { id: ID_A, label: 'Contoso Bank' }, { id: '', label: 'ghost' }],
    }), VIAS);
    expect(condition).toEqual({
      kind: 'org', entityType: 'Klant',
      entityIds: [ID_B, ID_A],
      labels: { [ID_B]: 'Northwind', [ID_A]: 'Contoso Bank' },
    });
  });

  it('labels a picked entity without a name by its id', () => {
    const { condition } = buildOrgCondition(draft({ picked: [{ id: ID_A }] }), VIAS);
    expect(condition.labels).toEqual({ [ID_A]: ID_A });
  });

  it('combines picked entities and an attribute (the API ANDs them)', () => {
    const { condition } = buildOrgCondition(draft({
      picked: [{ id: ID_A, label: 'Contoso Bank' }], attributeKey: 'iso27001', attributeValues: ['Ja'],
    }), VIAS);
    expect(condition.entityIds).toEqual([ID_A]);
    expect(condition.attribute).toEqual({ key: 'iso27001', values: ['Ja'] });
  });

  it('omits via while every link is ticked, and lists only the ticked ones otherwise', () => {
    expect(buildOrgCondition(draft(), VIAS).condition).not.toHaveProperty('via');
    expect(buildOrgCondition(draft({ uncheckedVias: ['team'] }), VIAS).condition.via).toEqual(['eigenaar', 'Uren']);
    expect(buildOrgCondition(draft({ uncheckedVias: ['eigenaar', 'Uren'] }), VIAS).condition.via).toEqual(['team']);
  });

  it('ignores an unticked name that is not among the options shown', () => {
    expect(buildOrgCondition(draft({ uncheckedVias: ['gone'] }), VIAS).condition).not.toHaveProperty('via');
  });

  it('refuses a condition with every link unticked', () => {
    const r = buildOrgCondition(draft({ uncheckedVias: ['eigenaar', 'team', 'Uren'] }), VIAS);
    expect(r).toEqual({ problem: 'Tick at least one way of being linked.' });
  });

  it('is valid without any via options (not loaded, or the type has no links)', () => {
    expect(buildOrgCondition(draft(), []).condition).toEqual({ kind: 'org', entityType: 'Klant' });
    expect(buildOrgCondition(draft(), undefined).condition).toEqual({ kind: 'org', entityType: 'Klant' });
  });
});

describe('viasForSide', () => {
  const vias = [
    { name: 'eigenaar', targets: ['Principal'] },
    { name: 'team', targets: ['Identity'] },
    { name: 'app', targets: ['Resource'] },
    { name: 'groep', targets: ['Context'] },
    { name: 'unknown' },
  ];
  const names = (list) => list.map(v => v.name);

  it('keeps the links that reach subjects on the subject side', () => {
    expect(names(viasForSide(vias, 'Principal'))).toEqual(['eigenaar', 'team', 'groep', 'unknown']);
    expect(names(viasForSide(vias, 'Identity'))).toEqual(['eigenaar', 'team', 'groep', 'unknown']);
  });

  it('keeps the links that reach resources on the resource side', () => {
    expect(names(viasForSide(vias, 'Resource'))).toEqual(['app', 'groep', 'unknown']);
  });

  it('keeps everything for an unknown side and nothing for a missing list', () => {
    expect(viasForSide(vias, 'Other')).toBe(vias);
    expect(viasForSide(null, 'Principal')).toEqual([]);
  });
});

describe('orgConditionText', () => {
  it('names an attribute selection and the ticked links', () => {
    expect(orgConditionText({
      kind: 'org', entityType: 'Klant', attribute: { key: 'iso27001', values: ['Ja'] }, via: ['eigenaar', 'team'],
    })).toBe('Organisation · Klant · iso27001 = Ja · via eigenaar, team');
  });

  it('names picked entities by their labels', () => {
    expect(orgConditionText({
      kind: 'org', entityType: 'Klant', entityIds: [ID_A, ID_B], labels: { [ID_A]: 'Contoso Bank', [ID_B]: 'Northwind' },
    })).toBe('Organisation · Klant: Contoso Bank, Northwind');
  });

  it(`names at most ${CHIP_LABEL_LIMIT} and counts the rest`, () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const labels = { a1: 'Klant A', a2: 'Klant B', a3: 'Klant C', a4: 'Klant D', a5: 'Klant E' };
    expect(orgConditionText({ kind: 'org', entityType: 'Klant', entityIds: ids, labels }))
      .toBe('Organisation · Klant: Klant A, Klant B, Klant C +2 more');
    expect(orgConditionText({ kind: 'org', entityType: 'Klant', entityIds: ids.slice(0, 3), labels }))
      .toBe('Organisation · Klant: Klant A, Klant B, Klant C');
  });

  it('falls back to a short id for an entity without a label', () => {
    expect(orgConditionText({ kind: 'org', entityType: 'Klant', entityIds: [ID_A] }))
      .toBe('Organisation · Klant: 11111111');
  });

  it('says "every" when neither ids nor an attribute narrow it', () => {
    expect(orgConditionText({ kind: 'org', entityType: 'Klant' })).toBe('Organisation · every Klant');
    expect(orgConditionText({ kind: 'org', entityType: 'Klant', entityIds: [], via: ['Uren'] }))
      .toBe('Organisation · every Klant · via Uren');
  });

  it('shows ids and an attribute together, with several values', () => {
    expect(orgConditionText({
      kind: 'org', entityType: 'Klant', entityIds: [ID_A], labels: { [ID_A]: 'Contoso Bank' },
      attribute: { key: 'sector', values: ['Bank', 'Retail'] },
    })).toBe('Organisation · Klant: Contoso Bank · sector = Bank, Retail');
  });

  it('survives a hand-edited condition without a type', () => {
    expect(orgConditionText({ kind: 'org' })).toBe('Organisation · every ?');
  });
});

describe('selectsEveryEntity', () => {
  it('is false as soon as an id or an attribute narrows the type', () => {
    expect(selectsEveryEntity({ entityType: 'Klant', entityIds: [ID_A] })).toBe(false);
    expect(selectsEveryEntity({ entityType: 'Klant', attribute: { key: 'k', values: ['v'] } })).toBe(false);
    expect(selectsEveryEntity({ entityType: 'Klant', entityIds: [] })).toBe(true);
    expect(selectsEveryEntity(null)).toBe(true);
  });
});
