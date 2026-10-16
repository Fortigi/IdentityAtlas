import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getEnrichment, shapeEnrichment } from './read.js';

const P = 'p0000000-0000-4000-8000-000000000001';
const I = 'i0000000-0000-4000-8000-000000000001';

const row = (entityId, source, attributes) => ({ entityId, source, profileName: `${source} list`, attributes, tt: 'Principal', tid: P });

describe('shapeEnrichment', () => {
  it('one group per enrichment row, attributes as stored (lists stay lists), a row reached twice listed once', () => {
    expect(shapeEnrichment([
      row('m1', 'Maten', { expertises: ['IAM', 'Azure'], level: 'Senior' }),
      row('m1', 'Maten', { expertises: ['IAM', 'Azure'], level: 'Senior' }),
      row('c1', 'Certs', JSON.stringify({ cert: 'CISSP' })),
      row('x1', 'Empty', null),
    ])).toEqual({ groups: [
      { source: 'Maten', profileName: 'Maten list', entityId: 'm1', attributes: { expertises: ['IAM', 'Azure'], level: 'Senior' } },
      { source: 'Certs', profileName: 'Certs list', entityId: 'c1', attributes: { cert: 'CISSP' } },
      { source: 'Empty', profileName: 'Empty list', entityId: 'x1', attributes: {} },
    ] });
  });
});

describe('getEnrichment', () => {
  beforeEach(() => query.mockReset());

  it('a principal also gets the rows about its identity', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ identityId: I }] })
      .mockResolvedValueOnce({ rows: [row('m1', 'Maten', { level: 'Senior' })] });
    const out = await getEnrichment('Principal', P);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/AND l\."targetType" = ANY\(\$1::text\[\]\)\n\s+AND l\."targetId" = ANY\(\$2::uuid\[\]\)/);
    expect(sql).toMatch(/ORDER BY p\."name", e\."displayName", e\."id"$/);
    expect(params).toEqual([['Principal', 'Identity'], [P, I]]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].attributes).toEqual({ level: 'Senior' });
  });
});
