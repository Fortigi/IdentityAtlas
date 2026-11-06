import { describe, it, expect } from 'vitest';
import { entityEndpointFor, refsFor } from './endpoints.js';

const ID = '0a1b2c3d-0000-4000-8000-00000000abcd';

describe('entityEndpointFor — which object a detail path is about', () => {
  it.each([
    [`/api/user/${ID}`, 'principal'],
    [`/api/user/${ID}/memberships`, 'principal'],
    [`/api/user/${ID}/timeline`, 'principal'],
    [`/api/user/${ID}/recent-changes`, 'principal'],
    [`/api/user/${ID}/diff`, 'principal'],
    [`/api/identities/by-user/${ID}`, 'principal'],
    [`/api/org-chart/user/${ID}/manager`, 'principal'],
    [`/api/org-chart/user/${ID}/reports`, 'principal'],
    [`/api/identities/${ID}`, 'identity'],
    [`/api/identities/${ID}/assignments`, 'identity'],
    [`/api/identities/${ID}/diff`, 'identity'],
    [`/api/resources/${ID}`, 'resource'],
    [`/api/resources/${ID}/assignments`, 'resource'],
    [`/api/access-package/${ID}/timeline`, 'resource'],
    [`/api/access-package/${ID}/reviews`, 'resource'],
    [`/api/group/${ID}/members`, 'resource'],
    [`/api/risk-scores/users/${ID}`, 'principal'],
    [`/api/risk-scores/identities/${ID}`, 'identity'],
    [`/api/risk-scores/groups/${ID}`, 'resource'],
    [`/api/risk-scores/business-roles/${ID}`, 'resource'],
  ])('%s → %s', (path, kind) => {
    expect(entityEndpointFor(path)).toMatchObject({ kind, id: ID });
  });

  it.each([
    `/api/user/${ID}/`,                         // trailing slash
    `/api/user/${ID}/memberships/extra`,        // extra segment
    `/api/user/${ID.slice(0, -1)}`,             // not a uuid
    `/api/users/${ID}`,                         // the list route's neighbour
    '/api/user/by-name',
    `/api/identities/${ID}/members/${ID}/override`, // a write path
    `/api/risk-scores/users/${ID}/override`,
    `/api/risk-scores/contexts/${ID}`,          // the context's own (allow-listed elsewhere)
    `/api/matrix/data`,
    `/api/access-package/${ID}/policies/x`,
  ])('%s is not a detail path', (path) => {
    expect(entityEndpointFor(path)).toBeNull();
  });
});

describe('refsFor — where a response names other objects', () => {
  it('a group\'s assignments name principals', () => {
    expect(refsFor(`/api/resources/${ID}/assignments`)).toEqual([{ at: '', kind: 'principal', key: 'principalId' }]);
  });

  it('a timeline\'s events carry their own kind', () => {
    expect(refsFor(`/api/user/${ID}/timeline`)).toEqual([{ at: 'events', kindKey: 'counterpartyKind', key: 'counterpartyId' }]);
  });

  it('a diff marks both snapshots', () => {
    expect(refsFor(`/api/resources/${ID}/diff`).map(r => r.at)).toEqual(['before.relationships', 'after.relationships']);
  });

  it('a second ref on the same rows writes its own flag', () => {
    expect(refsFor(`/api/identities/${ID}/assignments`)).toEqual([
      { at: '', kind: 'resource', key: 'resourceId' },
      { at: '', kind: 'principal', key: 'principalId', flag: 'principalAccessible' },
    ]);
  });

  it('the owner\'s own context pages are marked too: members, people, roles, timeline', () => {
    expect(refsFor(`/api/contexts/${ID}/members`)).toEqual([{ at: 'data', kind: 'member', key: 'id' }]);
    expect(refsFor(`/api/contexts/${ID}/people`).map(r => r.kind)).toEqual(['principal', 'identity']);
    expect(refsFor(`/api/contexts/${ID}/roles`).map(r => r.at)).toEqual(['', '']);
    expect(refsFor(`/api/contexts/${ID}/timeline`)[0].at).toBe('events');
  });

  it('a path whose response names nothing has no refs', () => {
    expect(refsFor(`/api/resources/${ID}`)).toBeNull();
    expect(refsFor(`/api/risk-scores/users/${ID}`)).toBeNull();
    expect(refsFor(`/api/contexts/${ID}`)).toBeNull();
    expect(refsFor('/api/auth-me')).toBeNull();
  });
});
