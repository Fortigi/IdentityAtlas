// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixGroupRow from './MatrixGroupRow';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const users = [{ id: 'u1', displayName: 'Alice' }];

function renderRow(group, props = {}) {
  const onToggleRoleFold = props.onToggleRoleFold || vi.fn();
  const result = renderWithProviders(
    h('table', null, h('tbody', null,
      h(MatrixGroupRow, {
        group,
        users,
        totalUsers: users.length,
        memberships: new Map(),
        managedApMap: new Map(),
        apIdToIndex: new Map(),
        accessPackages: [],
        apGroupMap: new Map(),
        managedFilter: 'all',
        foldableRoles: new Set(['BR1']),
        foldedRoles: new Set(),
        roleChildCounts: new Map([['BR1', 2]]),
        ...props,
        onToggleRoleFold,
      }))),
  );
  return { ...result, onToggleRoleFold };
}

const foldButton = () => screen.queryByRole('button', { name: /fold business role resources/i });

describe('MatrixGroupRow — business-role fold affordance', () => {
  it('renders a labelled fold chevron on a foldable business-role row', () => {
    renderRow({ id: 'BR1', displayName: 'HR Manager BR', groupType: 'BusinessRole', memberCount: 3 });
    expect(screen.getByRole('button', { name: 'Fold business role resources' })).toBeInTheDocument();
    // Nothing is folded yet, so no chip.
    expect(screen.queryByText(/resources folded/i)).not.toBeInTheDocument();
  });

  it('shows the folded-count chip and the unfold label when the role is folded', () => {
    renderRow(
      { id: 'BR1', displayName: 'HR Manager BR', groupType: 'BusinessRole', memberCount: 3 },
      { foldedRoles: new Set(['BR1']) },
    );
    expect(screen.getByRole('button', { name: 'Unfold business role resources' })).toBeInTheDocument();
    expect(screen.getByText('2 resources folded')).toBeInTheDocument();
  });

  it('singularises the chip for a single folded resource', () => {
    renderRow(
      { id: 'BR1', displayName: 'HR Manager BR', memberCount: 1 },
      { foldedRoles: new Set(['BR1']), roleChildCounts: new Map([['BR1', 1]]) },
    );
    expect(screen.getByText('1 resource folded')).toBeInTheDocument();
  });

  it('reports the role id to onToggleRoleFold when clicked', async () => {
    const { onToggleRoleFold } = renderRow({ id: 'br1', displayName: 'HR Manager BR', memberCount: 1 });
    await userEvent.setup().click(screen.getByRole('button', { name: /fold business role resources/i }));
    expect(onToggleRoleFold).toHaveBeenCalledWith('BR1');
  });

  it('renders no fold chevron on a resource row that is not a foldable role', () => {
    renderRow({ id: 'G1', displayName: 'Finance Group', memberCount: 2 });
    expect(foldButton()).toBeNull();
  });

  it('renders no fold chevron on a nested sub-row', () => {
    renderRow({ id: 'X__nested__BR1', realGroupId: 'BR1', displayName: 'HR Manager BR', isNestedRow: true, nestLevel: 1 });
    expect(foldButton()).toBeNull();
  });

  it('renders nothing extra when no fold props are supplied at all', () => {
    renderRow(
      { id: 'BR1', displayName: 'HR Manager BR', memberCount: 1 },
      { foldableRoles: undefined, foldedRoles: undefined, roleChildCounts: undefined },
    );
    expect(foldButton()).toBeNull();
  });
});
