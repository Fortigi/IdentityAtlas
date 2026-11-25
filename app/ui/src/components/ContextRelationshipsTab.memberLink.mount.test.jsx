// @vitest-environment jsdom
//
// Which page a member row opens. A role portfolio holds business roles: those
// open the business role page, not the plain resource page the other members
// of a context of resources open.

import { describe, it, expect, vi } from 'vitest';
import { MembersPanel } from './ContextRelationshipsTab';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

function show(targetType, members, onOpenDetail) {
  return renderWithProviders(
    <MembersPanel
      contextId="c1" attrs={{ targetType, totalMemberCount: members.length, directMemberCount: members.length }}
      canEditMembers={false} includeDescendants={false} onIncludeDescendantsChange={() => {}}
      memberSearch="" onMemberSearchChange={() => {}} members={members} memberTotal={members.length}
      membersLoading={false} membersError={null} memberPage={0} onMemberPageChange={() => {}} pageSize={50}
      authFetch={vi.fn()} onMembersChanged={() => {}} onOpenDetail={onOpenDetail}
    />,
  );
}

async function openRow(targetType, member) {
  const open = vi.fn();
  show(targetType, [member], open);
  await userEvent.setup().click(screen.getByText(member.displayName));
  expect(open).toHaveBeenCalledTimes(1);
  return open.mock.calls[0];
}

describe('member row link', () => {
  it('opens a business role in a role portfolio on its business role page', async () => {
    expect(await openRow('Resource', { id: 'br-1', displayName: 'Finance clerk', resourceType: 'BusinessRole' }))
      .toEqual(['access-package', 'br-1', 'Finance clerk']);
  });

  it('opens any other resource on the resource page', async () => {
    expect(await openRow('Resource', { id: 'g-1', displayName: 'SAP readers', resourceType: 'Group' }))
      .toEqual(['group', 'g-1', 'SAP readers']);
  });

  it('opens a person on the identity page and an account on the account page', async () => {
    expect(await openRow('Identity', { id: 'i-1', displayName: 'Ada', resourceType: 'BusinessRole' }))
      .toEqual(['identity', 'i-1', 'Ada']);
  });

  it('opens an account on the account page', async () => {
    expect(await openRow('Principal', { id: 'p-1', displayName: 'ada@contoso.com' }))
      .toEqual(['user', 'p-1', 'ada@contoso.com']);
  });
});
