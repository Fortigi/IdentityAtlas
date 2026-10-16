import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('../linking/stats.js', () => ({ linkStats: vi.fn(async () => ({ Person: { total: 2, unique: 1 } })) }));

import { query } from '../../db/connection.js';
import { linkStats } from '../linking/stats.js';
import { dryRun, countWouldClose, ISSUE_REPORT_LIMIT } from './dryRun.js';

const source = { content: Buffer.from('Code;Project;Owner\nP-1;Atlas;Ann\nP-2;Beacon;Ann\nP-2;Beacon 2;Bob\n'), fileName: 'p.csv' };
const recipe = {
  version: 1,
  entities: [{ type: 'Project', keyColumn: 'Code', nameColumn: 'Project' }, { type: 'Person', nameColumn: 'Owner' }],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
};
const linkRules = [{ entityType: 'Person', targetType: 'Principal', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 80 }] }];

beforeEach(() => { query.mockReset(); linkStats.mockClear(); });

describe('dryRun', () => {
  it('reports rows, column profile, entity and relation counts, link stats and issues — writing nothing', async () => {
    const out = await dryRun({ source, recipe, linkRules, mode: 'delta' });
    expect(out.ok).toBe(true);
    const r = out.report;
    expect(r.rows).toBe(3);
    expect(r.columns.map(c => c.name)).toEqual(['Code', 'Project', 'Owner']);
    expect(r.entities).toEqual({
      Project: { total: 2, duplicateKeys: 1, emptyKeys: 0 },
      Person: { total: 2, duplicateKeys: 0, emptyKeys: 0 },
    });
    expect(r.relations).toEqual({ owner: 3 });
    expect(r.links).toEqual({ Person: { total: 2, unique: 1 } });
    expect(r.wouldClose).toEqual({});
    expect(r.issues).toEqual([expect.objectContaining({ kind: 'duplicateKey', entityType: 'Project', row: 3 })]);
    expect(r.issueCount).toBe(1);
    expect(query).not.toHaveBeenCalled();

    const [entities, rules] = linkStats.mock.calls[0];
    expect(entities.map(e => e.canonicalKey)).toEqual(['p-1', 'ann', 'p-2', 'bob']);
    expect(rules[0]).toMatchObject({ entityType: 'Person', threshold: 50 });
  });

  it('defaults missing link rules to none', async () => {
    const out = await dryRun({ source, recipe, mode: 'delta' });
    expect(out.ok).toBe(true);
    expect(linkStats.mock.calls[0][1]).toEqual([]);
  });

  it('returns the sentences when the recipe names a column the source does not have, or the rules do not fit', async () => {
    const bad = { ...recipe, entities: [{ type: 'Project', nameColumn: 'Nope' }] };
    const out = await dryRun({ source, recipe: bad, linkRules: [{ entityType: 'Ghost', targetType: 'Principal', signals: [] }], mode: 'full' });
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual(expect.arrayContaining([
      'Entity "Project" nameColumn refers to column "Nope", which the source does not have.',
      expect.stringContaining('"Ghost", which the recipe does not define'),
    ]));
    expect(linkStats).not.toHaveBeenCalled();
  });

  it('in full mode with a profile, counts per type the open entities this source no longer has', async () => {
    query.mockResolvedValue({ rows: [
      { entityType: 'Project', canonicalKey: 'p-1' }, { entityType: 'Project', canonicalKey: 'p-9' },
      { entityType: 'Person', canonicalKey: 'cas' }, { entityType: 'Person', canonicalKey: 'dan' },
    ] });
    const out = await dryRun({ source, recipe, linkRules, mode: 'full', profileName: 'Projects' });
    expect(out.report.wouldClose).toEqual({ Project: 1, Person: 2 });
    expect(query.mock.calls[0][1]).toEqual(['Projects']);
  });

  it('does not look for closures in full mode without a profile', async () => {
    const out = await dryRun({ source, recipe, linkRules, mode: 'full' });
    expect(out.report.wouldClose).toEqual({});
    expect(query).not.toHaveBeenCalled();
  });

  it('caps the issue list but keeps the full count', async () => {
    const lines = Array.from({ length: ISSUE_REPORT_LIMIT + 5 }, (_, i) => `;Nameless ${i};`).join('\n');
    const out = await dryRun({ source: { content: Buffer.from(`Code;Project;Owner\n${lines}`) }, recipe, linkRules: [], mode: 'delta' });
    expect(out.report.issues).toHaveLength(ISSUE_REPORT_LIMIT);
    expect(out.report.issueCount).toBe(ISSUE_REPORT_LIMIT + 5);
  });
});

describe('countWouldClose', () => {
  it('returns an empty object when everything open is still present', async () => {
    query.mockResolvedValue({ rows: [{ entityType: 'Project', canonicalKey: 'p-1' }] });
    expect(await countWouldClose('X', [{ entityType: 'Project', canonicalKey: 'p-1' }])).toEqual({});
  });
});

describe('dryRun — per template', () => {
  it('a collection report names its template', async () => {
    expect((await dryRun({ source, recipe, linkRules, mode: 'delta' })).report.template).toBe('collection');
  });

  it('a relation uses its generated rules (whatever the body sent) and counts its pairs', async () => {
    const rel = { version: 1, template: 'relation', relation: { type: 'Pair', predicate: 'p', left: { column: 'Code', targetType: 'Resource' }, right: { column: 'Owner', targetType: 'Principal' } } };
    const out = await dryRun({ source, recipe: rel, linkRules: [{ nonsense: true }], mode: 'delta' });
    expect(out.ok).toBe(true);
    expect(out.report.template).toBe('relation');
    expect(out.report.entities).toEqual({ Pair: { total: 3, duplicateKeys: 0, emptyKeys: 0 } });
    const [entities, rules] = linkStats.mock.calls[0];
    expect(entities.map(e => e.displayName)).toEqual(['P-1 → Ann', 'P-2 → Ann', 'P-2 → Bob']);
    expect(rules.map(r => [r.via, r.targetType])).toEqual([['left', 'Resource'], ['right', 'Principal']]);
  });

  it('a relation recipe that does not fit is refused on the recipe alone', async () => {
    const rel = { version: 1, template: 'relation', relation: { type: 'Pair', predicate: 'p', left: { column: 'Nope', targetType: 'Resource' }, right: { column: 'Owner', targetType: 'Principal' } } };
    const out = await dryRun({ source, recipe: rel, linkRules: [], mode: 'delta' });
    expect(out).toEqual({ ok: false, errors: ['The relation left end refers to column "Nope", which the source does not have.'] });
  });

  it('an activity gets the activity report: facts, skipped rows, sample, key counts — and no entity link stats', async () => {
    const act = { version: 1, template: 'activity', activity: { type: 'Hours', actor: { column: 'Owner', targetTypes: ['Principal'] }, subject: { column: 'Project', targetType: 'Resource' }, when: { dateColumn: 'Code' } } };
    const out = await dryRun({ source, recipe: act, linkRules: [], mode: 'delta' });
    expect(out.ok).toBe(true);
    expect(out.report).toMatchObject({ template: 'activity', rows: 3, activities: 0, skipped: 3, sample: [] });
    expect(out.report.keys.actor).toEqual({ total: 0, accepted: 0, proposed: 0, unmatched: 0 });
    expect(linkStats).not.toHaveBeenCalled();
  });

  it('an activity with link rules is refused', async () => {
    const act = { version: 1, template: 'activity', activity: { type: 'Hours', actor: { column: 'Owner', targetTypes: ['Principal'] }, subject: { column: 'Project', targetType: 'Resource' }, when: { dateColumn: 'Code' } } };
    const out = await dryRun({ source, recipe: act, linkRules, mode: 'delta' });
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual(['An activity import has no link rules: its actor and subject columns are matched per distinct value.']);
  });
});
