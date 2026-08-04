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

  it('uses the same triangle affordance as the nested-group expand', () => {
    renderRow({ id: 'BR1', displayName: 'HR Manager BR', memberCount: 3 });
    expect(screen.getByRole('button', { name: /fold business role resources/i })).toHaveTextContent('▼');
    renderRow(
      { id: 'BR2', displayName: 'Other BR', memberCount: 3 },
      { foldableRoles: new Set(['BR2']), foldedRoles: new Set(['BR2']), roleChildCounts: new Map([['BR2', 1]]) },
    );
    expect(screen.getByRole('button', { name: /unfold business role resources/i })).toHaveTextContent('▶');
  });
});

describe('MatrixGroupRow — a resource shown under the role that grants it', () => {
  it('indents the row and marks it with the nested elbow', () => {
    const { container } = renderRow({
      id: 'G1', displayName: 'Finance Group', memberCount: 2, roleParentId: 'BR1',
    });
    expect(screen.getByText('└')).toBeInTheDocument();
    expect(container.querySelector('td [style*="padding-left: 16px"]')).not.toBeNull();
  });

  it('indents a sub-row of such a resource one level deeper', () => {
    const { container } = renderRow({
      id: 'G1__nested__X', realGroupId: 'X', displayName: 'Nested', isNestedRow: true,
      nestLevel: 1, roleParentId: 'BR1',
    });
    expect(container.querySelector('td [style*="padding-left: 32px"]')).not.toBeNull();
  });

  it('leaves a resource no role grants flush left', () => {
    const { container } = renderRow({ id: 'G4', displayName: 'Unmanaged Group', memberCount: 1 });
    expect(screen.queryByText('└')).toBeNull();
    expect(container.querySelector('td [style*="padding-left: 0px"]')).not.toBeNull();
  });
});

describe('MatrixGroupRow — access a folded role does not grant', () => {
  const folded = {
    foldedRoles: new Set(['BR1']),
    roleExtraCounts: new Map([['BR1|u1', 3]]),
  };
  const role = { id: 'BR1', displayName: 'HR Manager BR', memberCount: 9 };
  // The cell and its corner badge share the explanation, so hovering anywhere
  // in the cell shows it; the badge is the innermost of the two.
  const extraBadge = () => screen.queryAllByTitle(/does not grant/).at(-1) ?? null;

  it('counts it on the folded role row', () => {
    renderRow(role, folded);
    expect(extraBadge()).toHaveTextContent('3');
  });

  it('shows nothing while the role is expanded — the rows speak for themselves', () => {
    renderRow(role, { roleExtraCounts: folded.roleExtraCounts });
    expect(extraBadge()).toBeNull();
  });

  it('tallies it on a folded subject column too', () => {
    renderRow(role, {
      ...folded,
      users: [{ id: 'agg-1', isAggregateCol: true, displayName: 'Engineering' }],
      roleExtraCounts: new Map([['BR1|agg-1', 5]]),
    });
    expect(extraBadge()).toHaveTextContent('5');
  });
});
