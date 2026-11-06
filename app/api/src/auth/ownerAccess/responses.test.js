import { describe, it, expect, vi } from 'vitest';
import { scopedBusinessRoles, responseShaperFor, BUSINESS_ROLE_CATALOGUE_PATH } from './responses.js';

const TEAM_ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const OUTSIDER_ROLE = 'bbbbbbbb-0000-4000-8000-000000000002';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUT = 'aaaaaaaa-0000-4000-8000-000000000002';

// Opens the role the team holds and the team member; nothing else.
const access = () => ({
  accessibleIds: vi.fn(async (kind, ids) => new Set(ids.map(i => String(i).toLowerCase())
    .filter(i => (kind === 'resource' ? i === TEAM_ROLE : i === TEAM)))),
});

const row = (id, groupId, name) => ({ accessPackageId: id, businessRoleId: id, accessPackageName: name, groupId, groupName: `g-${groupId}` });

describe('scopedBusinessRoles', () => {
  it('keeps every row of a role the team holds and drops a role held only by an outsider', async () => {
    const rows = [row(TEAM_ROLE, 'g1', 'Sales rep'), row(OUTSIDER_ROLE, 'g2', 'Treasury'), row(TEAM_ROLE.toUpperCase(), 'g3', 'Sales rep')];
    const a = access();
    expect(await scopedBusinessRoles(rows, a)).toEqual([rows[0], rows[2]]);
    expect(a.accessibleIds).toHaveBeenCalledTimes(1);
    expect(a.accessibleIds).toHaveBeenCalledWith('resource', [TEAM_ROLE, OUTSIDER_ROLE, TEAM_ROLE.toUpperCase()]);
  });

  it('reads the older accessPackageId when a row has no businessRoleId', async () => {
    const rows = [{ accessPackageId: TEAM_ROLE }, { accessPackageId: OUTSIDER_ROLE }];
    expect(await scopedBusinessRoles(rows, access())).toEqual([{ accessPackageId: TEAM_ROLE }]);
  });

  it('answers an empty list for anything that is not a list (an error body, nothing)', async () => {
    expect(await scopedBusinessRoles({ error: 'x' }, access())).toEqual([]);
    expect(await scopedBusinessRoles(null, access())).toEqual([]);
  });
});

describe('responseShaperFor', () => {
  it('cuts the business-role catalogue', async () => {
    const shape = responseShaperFor(BUSINESS_ROLE_CATALOGUE_PATH, access());
    expect(await shape([row(OUTSIDER_ROLE, 'g2', 'Treasury')])).toEqual([]);
  });

  it('marks the references of a detail path', async () => {
    const shape = responseShaperFor(`/api/resources/${TEAM_ROLE}/assignments`, access());
    expect(await shape([{ principalId: TEAM }, { principalId: OUT }])).toEqual([
      { principalId: TEAM, accessible: true }, { principalId: OUT, accessible: false },
    ]);
  });

  it('leaves any other path alone', () => {
    expect(responseShaperFor('/api/auth-me', access())).toBeNull();
    expect(responseShaperFor('/api/access-package-resources', access())).toBeNull();
  });
});
