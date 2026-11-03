// @vitest-environment jsdom
//
// The owner's team matrix shows the business roles the team holds — in the
// grouped (by unit) view and in the flat view — as an analyst's matrix does.

import { describe, it, expect } from 'vitest';
import OwnerTeamMatrix from './OwnerTeamMatrix';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { ContextOwnerScopeContext } from '@ui/contexts/ContextOwnerScopeContext';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUB = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const GROUP = 'cccccccc-0000-4000-8000-000000000001';

const flatBody = {
  rowType: 'principal',
  data: [
    { memberId: 'u1', memberDisplayName: 'Zelma Duniway', memberType: 'User', resourceId: GROUP, resourceDisplayName: 'Sales-Team', resourceType: 'Group', membershipType: 'Direct' },
  ],
  managedByPackages: [{ resourceId: GROUP, memberId: 'u1', accessPackageIds: [ROLE] }],
  resourceContexts: [], subjectCount: 1, subjectTotal: 1, resourceCount: 1, resourceTotal: 1, assignmentCount: 1,
};
const groupedBody = {
  rollup: 'context', rollupKind: 'context', layered: true, rollupContextId: UNIT, rollupContent: 'resources-and-roles', maxDepth: 1,
  nodes: [{ id: `${UNIT}:direct`, displayName: 'CTO — direct members', depth: 1, pathIds: [`${UNIT}:direct`], pathNames: ['CTO — direct members'], total: 1, directMembers: 1, childCount: 0 }],
  groupValues: [`${UNIT}:direct`], groupTotals: [{ groupValue: `${UNIT}:direct`, total: 1 }],
  resources: [{ resourceId: GROUP, resourceDisplayName: 'Sales-Team', resourceType: 'Group' }],
  counts: [{ resourceId: GROUP, groupValue: `${UNIT}:direct`, directCount: 1, governedCount: 1 }],
  businessRoles: [{ id: ROLE, displayName: 'Sales Representative' }],
  roleCounts: [{ resourceId: GROUP, roleId: ROLE, count: 1 }],
  resourceContexts: [], subjectCount: 1, subjectTotal: 1, resourceCount: 1, resourceTotal: 1, assignmentCount: 1,
};

function mount() {
  const authFetch = makeAuthFetch((url, opts) => {
    const u = String(url);
    if (u === `/api/contexts/${UNIT}`) return { attributes: { id: UNIT, displayName: 'CTO', targetType: 'Principal', contextCategory: 'OrganizationalUnit' } };
    if (u === '/api/access-package-groups') {
      return [{ accessPackageId: ROLE, businessRoleId: ROLE, accessPackageName: 'Sales Representative', resourceId: GROUP, groupId: GROUP, resourceName: 'Sales-Team', totalAssignments: 1 }];
    }
    if (u === '/api/matrix/data') return JSON.parse(opts.body).filter.sortHierarchy ? groupedBody : flatBody;
    return undefined;
  });
  renderWithProviders(
    <SharedViewContext.Provider value={true}>
      <ContextOwnerScopeContext.Provider value={new Set([UNIT, SUB])}>
        <OwnerTeamMatrix contextId={UNIT} onOpenDetail={() => {}} />
      </ContextOwnerScopeContext.Provider>
    </SharedViewContext.Provider>,
    { auth: { authFetch, authEnabled: true, hasWildcard: false, permissions: new Set() } },
  );
  return authFetch;
}

describe('OwnerTeamMatrix — the business roles the team holds', () => {
  it('shows them grouped by unit (as role columns)', async () => {
    mount();
    expect(await screen.findByTitle('Business role: Sales Representative', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows them in the flat view (Group by unit off)', async () => {
    mount();
    await screen.findByTitle('Business role: Sales Representative', {}, { timeout: 3000 });
    await userEvent.click(screen.getByTestId('group-by-unit'));
    // The flat grid: people as columns …
    await waitFor(() => {
      expect(screen.getByText('Zelma Duniway')).toBeTruthy();
      expect(screen.queryByTitle('Business role: Sales Representative')).toBeNull();
    }, { timeout: 3000 });
    // … and the business role the team holds, with the group it contains.
    expect(screen.getAllByText(/Sales Representative/).length).toBeGreaterThan(0);
  });
});
