import { describe, it, expect, vi } from 'vitest';
import { MAX_MEMBERS, MEMBERS_SQL, RESOURCES_SQL, capped, readInterviewContext } from './contextRead.js';

const SUBJECT = '11111111-1111-4111-8111-111111111111';
const SCOPE = '22222222-2222-4222-8222-222222222222';

function fakeQuery({ subject = null, scope = null, members = [], resources = [] }) {
  return vi.fn(async (sql) => {
    if (sql.includes('FROM "Identities" i WHERE i."id" = $1')) return { rows: subject ? [subject] : [] };
    if (sql.includes('FROM "Contexts" c WHERE c."id" = $1') && !sql.includes('RECURSIVE')) return { rows: scope ? [scope] : [] };
    if (sql === MEMBERS_SQL) return { rows: members };
    if (sql === RESOURCES_SQL) return { rows: resources };
    throw new Error(`unexpected SQL ${sql.slice(0, 80)}`);
  });
}

describe('readInterviewContext', () => {
  it('answers 404 for an unknown subject before reading anything else', async () => {
    const query = fakeQuery({});
    expect(await readInterviewContext(query, { subjectIdentityId: SUBJECT, scopeContextId: SCOPE })).toEqual({ status: 404, error: 'Subject not found' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses a scope that is not a context of people', async () => {
    const query = fakeQuery({ scope: { id: SCOPE, displayName: 'Apps', contextType: 'Application', targetType: 'Resource' } });
    const out = await readInterviewContext(query, { subjectIdentityId: null, scopeContextId: SCOPE });
    expect(out.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns the subject and the team with numeric counts', async () => {
    const query = fakeQuery({
      subject: { id: SUBJECT, displayName: 'Marieke Bos', jobTitle: 'Manager ICT', department: 'ICT', accountCount: '2' },
      scope: { id: SCOPE, displayName: 'ICT Beheer', contextType: 'Department', targetType: 'Identity' },
      members: [{ id: 'p1', kind: 'identity', displayName: 'Peter Jansen', jobTitle: 'DBA', department: 'ICT', direct: '4', indirect: '9', eligible: '0', total: '2' },
        { id: 'w1', kind: 'account', displayName: 'William de Boer', jobTitle: null, department: 'ICT', direct: '1', indirect: '0', eligible: '2', total: '2' }],
      resources: [{ id: 'r1', displayName: 'SQL-Admins', resourceType: 'Group', holders: '2', total: '1' }],
    });
    const out = await readInterviewContext(query, { subjectIdentityId: SUBJECT, scopeContextId: SCOPE });
    expect(out.status).toBe(200);
    expect(out.body.subject.accountCount).toBe(2);
    expect(out.body.scope.members).toEqual({
      items: [
        { id: 'p1', kind: 'identity', displayName: 'Peter Jansen', jobTitle: 'DBA', department: 'ICT', direct: 4, indirect: 9, eligible: 0 },
        { id: 'w1', kind: 'account', displayName: 'William de Boer', jobTitle: null, department: 'ICT', direct: 1, indirect: 0, eligible: 2 },
      ],
      total: 2,
      truncated: false,
    });
    expect(out.body.scope.resources.items).toEqual([{ id: 'r1', displayName: 'SQL-Admins', resourceType: 'Group', holders: 2 }]);
  });

  it('reads the subject alone without touching the team queries', async () => {
    const query = fakeQuery({ subject: { id: SUBJECT, displayName: 'M', jobTitle: null, department: null, accountCount: 0 } });
    const out = await readInterviewContext(query, { subjectIdentityId: SUBJECT, scopeContextId: null });
    expect(out.body.scope).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('capped', () => {
  it('reports a cut only when the total exceeds the cap', () => {
    expect(capped([{ a: 1, total: String(MAX_MEMBERS) }], MAX_MEMBERS)).toEqual({ items: [{ a: 1 }], total: MAX_MEMBERS, truncated: false });
    expect(capped([{ a: 1, total: String(MAX_MEMBERS + 1) }], MAX_MEMBERS).truncated).toBe(true);
    expect(capped([], MAX_MEMBERS)).toEqual({ items: [], total: 0, truncated: false });
  });
});

describe('the team SQL', () => {
  it('excludes ownership rows and soft-deleted assignments, accounts and resources', () => {
    for (const sql of [MEMBERS_SQL, RESOURCES_SQL]) {
      expect(sql).toMatch(/r\."resourceType" NOT IN \(/);
      expect(sql).toContain('ra."deletedAt" IS NULL');
      expect(sql).toContain('p."deletedAt" IS NULL');
    }
  });

  it('counts holders per person, so two accounts of one person are one holder', () => {
    expect(RESOURCES_SQL).toContain('count(DISTINCT tp."personId")');
  });

  it('caps both lists and reports the total alongside', () => {
    expect(MEMBERS_SQL).toMatch(/LIMIT 200$/);
    expect(RESOURCES_SQL).toMatch(/LIMIT 50$/);
    expect(MEMBERS_SQL).toContain('count(*) OVER ()');
  });
});
