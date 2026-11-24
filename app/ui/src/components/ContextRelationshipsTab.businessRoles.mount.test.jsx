// @vitest-environment jsdom
//
// The business-role matrix on an application's resources: the fixed columns,
// then one column per role with a tick where the role contains the resource.

import { describe, it, expect, vi } from 'vitest';
import { visibleMemberColumns } from './ContextRelationshipsTab.helpers';
import { MembersPanel } from './ContextRelationshipsTab';
import { renderWithProviders, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';

const role = (id, displayName, extra = {}) => ({ id, displayName, ...extra });
const finance = role('r-f', 'Finance');
const audit = role('r-a', 'Audit');

const resource = (id, displayName, businessRoles, extra = {}) => ({
  id, displayName, businessRoles, resourceType: 'Group', description: `${displayName} text`,
  enabled: true, ownerDisplayName: 'Olivia Owner', holderCount: 7, ...extra,
});

function Panel({ members, onOpenDetail = vi.fn() }) {
  return (
    <MembersPanel
      contextId="c1" attrs={{ targetType: 'Resource', totalMemberCount: members.length, directMemberCount: members.length }}
      canEditMembers={false} includeDescendants={false} onIncludeDescendantsChange={() => {}}
      memberSearch="" onMemberSearchChange={() => {}} members={members} memberTotal={members.length}
      membersLoading={false} membersError={null} memberPage={0} onMemberPageChange={() => {}} pageSize={50}
      authFetch={vi.fn()} onMembersChanged={() => {}} onOpenDetail={onOpenDetail}
    />
  );
}

const labels = (members) => visibleMemberColumns('Resource', members).map(c => c.label);

describe('business-role columns', () => {
  it('keeps type, description, owner and users, then one column per role by name', () => {
    const members = [resource('a', 'A', [finance]), resource('b', 'B', [audit, finance])];
    expect(labels(members)).toEqual(['Type', 'Description', 'Status', 'Owner', 'Users', 'Audit', 'Finance']);
  });

  it('keeps one column saying "none" when nothing on the page is in a role', () => {
    const [shown] = visibleMemberColumns('Resource', [resource('a', 'A', [])]).filter(c => c.label === 'Business roles');
    renderWithProviders(<div>{shown.render({ businessRoles: [] }, {})}</div>);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('is left out when the rows carry no role data at all', () => {
    expect(labels([{ id: 'a', displayName: 'A', resourceType: 'Group' }])).toEqual(['Type']);
  });

  it('gives two roles with the same name their own columns', () => {
    const twin = role('r-z', 'Finance');
    const columns = visibleMemberColumns('Resource', [resource('a', 'A', [twin, finance])]).filter(c => c.matrix);
    expect(columns.map(c => c.key)).toEqual(['role:r-f', 'role:r-z']);
  });

  it('adds no role columns to members that are not resources', () => {
    expect(visibleMemberColumns('Principal', [{ id: 'p', email: 'x@y', businessRoles: [finance] }]).map(c => c.label)).toEqual(['Email']);
  });
});

describe('business-role matrix', () => {
  it('ticks exactly the roles that contain each resource', () => {
    renderWithProviders(<Panel members={[resource('a', 'Reader', [finance]), resource('b', 'Writer', [audit])]} />);
    expect(screen.getByRole('img', { name: 'Reader is in Finance' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Writer is in Audit' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Reader is in Audit' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Writer is in Finance' })).toBeNull();
    expect(screen.getByText('Reader is not in Audit')).toBeInTheDocument();
  });

  it('still shows the owner, the user count, the type and the description on a row', () => {
    renderWithProviders(<Panel members={[resource('a', 'Reader', [finance])]} />);
    const row = screen.getByRole('img', { name: 'Reader is in Finance' }).closest('tr');
    expect(within(row).getByText('Olivia Owner')).toBeInTheDocument();
    expect(within(row).getByText('7')).toBeInTheDocument();
    expect(within(row).getByText('Group')).toBeInTheDocument();
    expect(within(row).getByText('Reader text')).toBeInTheDocument();
  });

  it('opens a role from its heading without opening a row', async () => {
    const open = vi.fn();
    renderWithProviders(<Panel members={[resource('a', 'Reader', [finance])]} onOpenDetail={open} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finance' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('access-package', 'r-f', 'Finance');
  });

  it('names a role the reader may not open, without a link', () => {
    renderWithProviders(<Panel members={[resource('a', 'Reader', [role('r-f', 'Finance', { accessible: false })])]} />);
    expect(screen.getByRole('columnheader', { name: /Finance/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finance/ })).toBeNull();
  });

  it('hides an unticked cell on the narrow card layout and keeps a ticked one', () => {
    renderWithProviders(<Panel members={[resource('a', 'Reader', [finance]), resource('b', 'Writer', [audit])]} />);
    expect(screen.getByText('Reader is not in Audit').closest('td')).toHaveClass('hidden');
    expect(screen.getByRole('img', { name: 'Reader is in Finance' }).closest('td')).not.toHaveClass('hidden');
  });

  it('keeps the name in view only when there are role columns', () => {
    const { unmount } = renderWithProviders(<Panel members={[resource('a', 'Reader', [finance])]} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('sm:sticky');
    unmount();
    renderWithProviders(<Panel members={[resource('a', 'Reader', [])]} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveClass('sm:sticky');
  });
});
