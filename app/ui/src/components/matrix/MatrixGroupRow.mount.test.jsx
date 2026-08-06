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
        roleFoldInfo: new Map([['BR1', { total: 2 }]]),
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
      { foldedRoles: new Set(['BR1']), roleFoldInfo: new Map([['BR1', { total: 1 }]]) },
    );
    expect(screen.getByText('1 resource folded')).toBeInTheDocument();
  });

  // Feedback on #370: every resource a role grants has a row of its own under
  // that role — including the ones another role grants too — so a fold always
  // takes away exactly what the role grants and the chip never has to hedge.
  it('counts every resource the role grants, shared ones included', () => {
    renderRow(
      { id: 'BR1', displayName: 'HR Manager BR', memberCount: 3 },
      { foldedRoles: new Set(['BR1']), roleFoldInfo: new Map([['BR1', { total: 3 }]]) },
    );
    expect(screen.getByText('3 resources folded')).toBeInTheDocument();
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
      { foldableRoles: undefined, foldedRoles: undefined, roleFoldInfo: undefined },
    );
    expect(foldButton()).toBeNull();
  });

  it('uses the same triangle affordance as the nested-group expand', () => {
    renderRow({ id: 'BR1', displayName: 'HR Manager BR', memberCount: 3 });
    expect(screen.getByRole('button', { name: /fold business role resources/i })).toHaveTextContent('▼');
    renderRow(
      { id: 'BR2', displayName: 'Other BR', memberCount: 3 },
      { foldableRoles: new Set(['BR2']), foldedRoles: new Set(['BR2']), roleFoldInfo: new Map([['BR2', { total: 1 }]]) },
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

// Requestor feedback on #370: a resource now has a row under every business
// role that grants it, so the chip's job is to point at the OTHER rows.
describe('MatrixGroupRow — which business role a resource belongs to', () => {
  const owners = [{ id: 'BR2', name: 'Finance BR' }];

  it('marks a resource that another business role grants as well', async () => {
    const onOpenDetail = vi.fn();
    renderRow(
      {
        id: 'G1', displayName: 'Finance Group', memberCount: 2, roleParentId: 'BR1',
        roleOwners: owners, roleGrantedBy: 'HR Manager BR, Finance BR',
      },
      { onOpenDetail },
    );
    const chip = screen.getByRole('button', { name: 'Also granted by business role: Finance BR' });
    expect(chip).toHaveAttribute('title', 'Also granted by business role: Finance BR');
    // The chip is a way into the other role — and into its copy of this row.
    await userEvent.setup().click(chip);
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'BR2', 'Finance BR');
  });

  // The chip does not need to spell out role names in the resource column — a
  // "BR" / "BR+N" marker plus the tooltip is enough.
  it('labels the chip BR and keeps the role name in the tooltip only', () => {
    renderRow({ id: 'G1', displayName: 'Finance Group', memberCount: 2, roleOwners: owners });
    expect(screen.getByRole('button', { name: /Also granted by business role/ })).toHaveTextContent('BR');
    expect(screen.queryByText('Finance BR')).toBeNull();
  });

  it('counts the other granting roles on the chip and lists them all in the tooltip', () => {
    renderRow({
      id: 'G2', displayName: 'Shared Group', memberCount: 2,
      roleOwners: [...owners, { id: 'BR3', name: 'IT Ops BR' }],
    });
    const chip = screen.getByRole('button', { name: 'Also granted by business role: Finance BR, IT Ops BR' });
    expect(chip).toHaveTextContent('BR+2');
  });

  it('names every granting role in the row tooltip, from any of its rows', () => {
    const { container } = renderRow({
      id: 'G1', displayName: 'Finance Group', memberCount: 2, roleParentId: 'BR1',
      roleGrantedBy: 'HR Manager BR, Finance BR',
    });
    expect(container.querySelector('td[title*="Granted by business role: HR Manager BR, Finance BR"]'))
      .not.toBeNull();
  });

  it('leaves a resource only one business role grants uncluttered', () => {
    renderRow({
      id: 'G1', displayName: 'Finance Group', memberCount: 2, roleParentId: 'BR1',
      roleGrantedBy: 'HR Manager BR',
    });
    expect(screen.queryByRole('button', { name: /Also granted by business role/ })).toBeNull();
  });

  it('leaves a resource no business role grants unlabelled', () => {
    renderRow({ id: 'G4', displayName: 'Unmanaged Group', memberCount: 1 });
    expect(screen.queryByRole('button', { name: /BR/ })).toBeNull();
  });

  // A role's children move with the role, so they carry no drag handle of their
  // own — the same rule nested sub-rows already followed.
  it('gives a role child no drag handle', () => {
    const { container } = renderRow({
      id: 'G1', displayName: 'Finance Group', memberCount: 2, roleParentId: 'BR1',
    });
    expect(container.querySelector('td.cursor-grab')).toBeNull();
    expect(screen.queryByText('☰')).toBeNull();
  });

  it('keeps the drag handle on a resource that belongs to no role', () => {
    const { container } = renderRow({ id: 'G4', displayName: 'Unmanaged Group', memberCount: 1 });
    expect(container.querySelector('td.cursor-grab')).not.toBeNull();
  });
});

describe('MatrixGroupRow — how a cell deviates from what its role assigns', () => {
  const cellRow = { id: 'G1', displayName: 'Finance Group', memberCount: 1 };
  const covered = {
    managedApMap: new Map([['g1|u1', ['br1']]]),
    apIdToIndex: new Map([['br1', 0]]),
    accessPackages: [{ id: 'br1', displayName: 'HR Manager BR' }],
  };

  it('marks the cell when the role assigns a membership the subject lacks', () => {
    renderRow(cellRow, { ...covered, apGroupMap: new Map([['G1|br1', 'Member']]) });
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('marks the cell when the subject holds permanently what the role grants just-in-time', () => {
    renderRow(cellRow, {
      ...covered,
      apGroupMap: new Map([['G1|br1', 'Eligible Member']]),
      memberships: new Map([['G1|u1', new Set(['Direct'])]]),
    });
    expect(screen.getByText('+')).toBeInTheDocument();
    expect(screen.queryByText('!')).toBeNull();
  });

  it('marks nothing when the subject holds exactly what the role assigns', () => {
    renderRow(cellRow, {
      ...covered,
      apGroupMap: new Map([['G1|br1', 'Member']]),
      memberships: new Map([['G1|u1', new Set(['Direct'])]]),
    });
    expect(screen.queryByText('!')).toBeNull();
    expect(screen.queryByText('+')).toBeNull();
  });

  it('marks nothing on a cell no business role covers', () => {
    renderRow(cellRow, { apGroupMap: new Map([['G1|br1', 'Member']]) });
    expect(screen.queryByText('!')).toBeNull();
  });
});

// Requestor feedback on #370: on the row of a resource a business role grants,
// a subject who holds it *without* that role showed a bare badge. The folded
// role already counts exactly this access in red, so unfolding it must not make
// the finding disappear.
describe('MatrixGroupRow — a membership held outside the role that grants the row', () => {
  const grantedRow = {
    id: 'G1', displayName: 'SG-VPN-Access', memberCount: 10,
    roleParentId: 'BR1', roleGrantIds: ['BR1'], roleGrantedBy: 'BR-Engineering-Tools',
  };
  const held = new Map([['G1|u1', new Set(['Direct'])]]);
  const outsideBadge = () => screen.queryAllByTitle(/Held outside/).at(-1) ?? null;

  it('marks the cell of a subject the role does not hand the resource to', () => {
    renderRow(grantedRow, { memberships: held });
    expect(outsideBadge()).toHaveTextContent('1');
    const title = outsideBadge().getAttribute('title');
    expect(title).toContain('BR-Engineering-Tools');
    // Requestor feedback on #370: the marker reports the granting role's missing
    // assignment; it never claims the subject does not hold that role.
    expect(title).toContain('no business role assigns this resource to this subject');
    expect(title).not.toContain('does not hold');
    // The access itself is still shown for what it is.
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  // The requestor's case: the subject DOES hold BR-Engineering-Tools, but the
  // role carries no assignment matching this resource for them. Holding the role
  // is read off the coverage view's self arm (migration 061), not guessed.
  it('says the subject holds the granting role when the coverage view says so', () => {
    renderRow(grantedRow, {
      memberships: held,
      managedApMap: new Map([['br1|u1', ['br1']]]),
    });
    const title = outsideBadge().getAttribute('title');
    expect(title).toContain('this subject holds a business role that grants this resource');
    expect(title).toContain('but the role does not assign it to them');
    expect(title).not.toContain('does not hold');
  });

  // A role covers a cell only by granting the resource to someone who holds the
  // role, so a role outside this matrix's scope still accounts for the access.
  it('marks nothing when a business role outside the grid accounts for the access', () => {
    renderRow(grantedRow, {
      memberships: held,
      managedApMap: new Map([['g1|u1', ['br-off-grid']]]),
    });
    expect(outsideBadge()).toBeNull();
  });

  it('marks nothing for a subject who holds it through the role', () => {
    renderRow(grantedRow, {
      memberships: new Map([['G1|u1', new Set(['Indirect'])]]),
      managedApMap: new Map([['g1|u1', ['br1']]]),
      apIdToIndex: new Map([['br1', 0]]),
      accessPackages: [{ id: 'br1', displayName: 'BR-Engineering-Tools' }],
      apGroupMap: new Map([['G1|br1', 'Member']]),
    });
    expect(outsideBadge()).toBeNull();
  });

  it('marks nothing on a subject who does not hold the resource at all', () => {
    renderRow(grantedRow, { memberships: new Map() });
    expect(outsideBadge()).toBeNull();
  });

  it('marks nothing on a row no business role grants', () => {
    renderRow({ id: 'G1', displayName: 'Ad-hoc Group', memberCount: 1 }, { memberships: held });
    expect(outsideBadge()).toBeNull();
  });

  it('stays out of the non-governed view, like every other business-role indicator', () => {
    renderRow(grantedRow, { memberships: held, managedFilter: 'unmanaged' });
    expect(outsideBadge()).toBeNull();
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
  const extraBadge = () => screen.queryAllByTitle(/does not account for/).at(-1) ?? null;

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

describe('MatrixGroupRow — access a folded role assigns but the subject lacks', () => {
  const role = { id: 'BR1', displayName: 'HR Manager BR', memberCount: 9 };
  const missingBadge = () => screen.queryAllByTitle(/does not have/).at(-1) ?? null;
  const extraBadge = () => screen.queryAllByTitle(/does not account for/).at(-1) ?? null;

  it('counts it on the folded role row', () => {
    renderRow(role, { foldedRoles: new Set(['BR1']), roleMissingCounts: new Map([['BR1|u1', 2]]) });
    expect(missingBadge()).toHaveTextContent('2');
  });

  it('shows both directions of drift on the same subject at once', () => {
    renderRow(role, {
      foldedRoles: new Set(['BR1']),
      roleMissingCounts: new Map([['BR1|u1', 1]]),
      roleExtraCounts: new Map([['BR1|u1', 4]]),
    });
    expect(missingBadge()).toHaveTextContent('1');
    expect(extraBadge()).toHaveTextContent('4');
  });

  it('shows nothing while the role is expanded — the rows speak for themselves', () => {
    renderRow(role, { roleMissingCounts: new Map([['BR1|u1', 2]]) });
    expect(missingBadge()).toBeNull();
  });

  it('tallies it on a folded subject column too', () => {
    renderRow(role, {
      foldedRoles: new Set(['BR1']),
      users: [{ id: 'agg-1', isAggregateCol: true, displayName: 'Engineering' }],
      roleMissingCounts: new Map([['BR1|agg-1', 3]]),
      roleExtraCounts: new Map([['BR1|agg-1', 2]]),
    });
    expect(missingBadge()).toHaveTextContent('3');
    expect(extraBadge()).toHaveTextContent('2');
  });
});
