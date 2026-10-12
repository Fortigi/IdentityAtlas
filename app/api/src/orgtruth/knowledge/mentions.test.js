import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('./resolve.js', () => ({ resolveMentions: vi.fn() }));
import { query, queryOne } from '../../db/connection.js';
import { resolveMentions } from './resolve.js';
import { editMention, renamedMentions } from './mentions.js';
import { KnowledgeReviewError } from './review.js';

const ID = '11111111-1111-4111-8111-111111111111';
const row = { id: ID, displayName: 'FortiG', sourceId: 's', attributes: { mentionType: 'organisation', label: 'FortiG', occurrences: [{ seq: 1 }] } };

beforeEach(() => {
  query.mockReset(); queryOne.mockReset();
  query.mockResolvedValue({ rows: [] });
  resolveMentions.mockResolvedValue(new Map([['edit', { status: 'candidates', candidates: [
    { targetType: 'Context', targetId: 'c1', label: 'Fortigi', confidence: 90, signals: ['displayName exact'], matchedField: 'displayName', matchedValue: 'Fortigi' },
  ] }]]));
});

const fails = async (p, status) => {
  const err = await p.catch(e => e);
  expect(err).toBeInstanceOf(KnowledgeReviewError);
  expect(err.httpStatus).toBe(status);
};

describe('editMention', () => {
  it('renames everywhere, keeps the literal spelling and looks for candidates under the new name', async () => {
    queryOne.mockResolvedValue(row);
    const out = await editMention(ID, { label: ' Fortigi ' }, 'wim');
    expect(out.mention).toMatchObject({ label: 'Fortigi', type: 'organisation', originalLabel: 'FortiG', resolution: 'candidates' });
    expect(resolveMentions).toHaveBeenCalledWith([{ key: 'edit', type: 'organisation', label: 'Fortigi' }]);
    const [, params] = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "OrgEntities"'));
    expect(params[1]).toBe('Fortigi');
    expect(JSON.parse(params[2])).toMatchObject({ label: 'Fortigi', originalLabel: 'FortiG', renamedBy: 'wim', mentionType: 'organisation' });
    // stale machine proposals go, decided ones stay; the new candidate is upserted
    const drop = query.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM "OrgLinks"'));
    expect(drop[0]).toContain('"analystOverride" IS NULL');
    expect(drop[1]).toEqual([ID, 'mention', ['Context:c1']]);
    expect(query.mock.calls.some(([sql, p]) => sql.includes('INSERT INTO "OrgLinks"') && p[2] === 'Context' && p[10] === 'Fortigi')).toBe(true);
  });

  it('a second rename keeps the FIRST literal spelling; a type change alone is recorded as such', async () => {
    queryOne.mockResolvedValue({ ...row, displayName: 'Fortigi BV', attributes: { ...row.attributes, originalLabel: 'FortiG' } });
    await editMention(ID, { label: 'Fortigi', type: 'customer' }, 'wim');
    const attrs = JSON.parse(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE')) [1][2]);
    expect(attrs).toMatchObject({ originalLabel: 'FortiG', mentionType: 'customer', typeChangedBy: 'wim' });
    queryOne.mockResolvedValue(row);
    query.mockClear();
    await editMention(ID, { type: 'organisation' }, 'wim');
    const same = JSON.parse(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))[1][2]);
    expect(same.renamedBy).toBeUndefined();
    expect(same.typeChangedBy).toBeUndefined();
  });

  it('validates', async () => {
    await fails(editMention('x', { label: 'a' }, 'wim'), 400);
    await fails(editMention(ID, {}, 'wim'), 400);
    await fails(editMention(ID, { label: '  ' }, 'wim'), 400);
    await fails(editMention(ID, { label: 'x'.repeat(121) }, 'wim'), 400);
    await fails(editMention(ID, { type: 'planet' }, 'wim'), 400);
    queryOne.mockResolvedValue(null);
    await fails(editMention(ID, { label: 'Fortigi' }, 'wim'), 404);
  });
});

it('renamedMentions maps the pipeline key to the reviewer\'s name and type', async () => {
  query.mockResolvedValue({ rows: [{ canonicalKey: 'organisation:fortig', displayName: 'Fortigi', attributes: { mentionType: 'organisation' } }] });
  expect(await renamedMentions('s')).toEqual(new Map([['organisation:fortig', { label: 'Fortigi', type: 'organisation' }]]));
  expect(query.mock.calls[0][0]).toContain(`"attributes" ? 'renamedBy' OR "attributes" ? 'typeChangedBy'`);
});
