// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixColumnHeaders from './MatrixColumnHeaders';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';

// Each subject gets a distinct sortKeys pair, so every span is a single column
// whose lead cell we control — letting us exercise the aggregate, member-explode
// and plain-group branches of a grouping cell independently.
function makeUsers() {
  return [
    { id: 'agg1', value: 'Finance', userCount: 3, isAggregateCol: true, level: 0, sortKeys: ['Finance', 'Payroll'], childCounts: [0, 2] },
    { id: 'mem1', value: 'Ops', isMemberCol: true, memberLevel: 0, sortKeys: ['Ops', 'Logistics'] },
    { id: 'id1', displayName: 'Alice', memberType: 'Identity', sortKeys: ['HR', 'Recruiting'] },
    // Account sub-column of the expanded identity id1 — makeAccountCol() stamps
    // parentId and copies the parent's sortKeys, so mirror both here.
    { id: 'acc1', displayName: 'Bob', isAccountCol: true, parentId: 'id1', accountType: 'AAD', sortKeys: ['HR', 'Recruiting'] },
    { id: 'u5', displayName: 'Carl', jobTitle: 'Rep', department: 'Sales', sortKeys: ['Sales', 'Field'] },
  ];
}

const accessPackages = [
  { id: 'ap1', displayName: 'Package One', catalogName: 'Cat', categoryName: 'Alpha' },
  { id: 'ap2', displayName: 'Package Two', catalogName: 'Cat', categoryName: 'Beta' },
];

function renderRich(overrides = {}) {
  const handlers = {
    onSortByCount: vi.fn(),
    onOpenDetail: vi.fn(),
    onToggleIdentity: vi.fn(),
    onToggleMembers: vi.fn(),
    onToggleCollapse: vi.fn(),
    ...overrides,
  };
  const result = renderWithProviders(
    h('table', null,
      h(MatrixColumnHeaders, {
        users: makeUsers(),
        infoColumnCount: 3,
        accessPackages,
        expandedIdentities: new Set(['id1']),
        loadingIdentityCols: new Set(),
        sortAttributes: [{ attribute: 'department' }, { attribute: 'division' }],
        ...handlers,
      })),
  );
  return { ...result, handlers };
}

describe('MatrixColumnHeaders rich columns', () => {
  it('renders aggregate, member, identity, account and access-package columns', () => {
    renderRich();
    // Aggregate grouping cell (present on its own row and the deeper child-count row).
    expect(screen.getAllByTitle('Expand Finance back into its columns').length).toBe(2);
    expect(screen.getByTitle('Collapse Ops members back into a count')).toBeInTheDocument();
    // Child count on the deeper aggregate row.
    expect(screen.getByText('2')).toBeInTheDocument();
    // Account label appends its type; identity keeps its plain name.
    expect(screen.getByText('Bob · AAD')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // Both access-package labels render on the pinned names row.
    expect(screen.getByText('Package One')).toBeInTheDocument();
    expect(screen.getByText('Package Two')).toBeInTheDocument();
  });

  it('renders expanded-identity accounts in their own header row under the identity span', () => {
    renderRich(); // id1 (Alice) is expanded; acc1 (Bob · AAD) is her account column
    const identityCell = screen.getByText('Alice').closest('th');
    const accountCell = screen.getByText('Bob · AAD').closest('th');
    const identityRow = identityCell.closest('tr');
    const accountRow = accountCell.closest('tr');

    // The identity header spans its own roll-up column plus its account column…
    expect(identityCell.colSpan).toBe(2);
    // …and the account label sits in a separate header row BELOW the names row,
    // not spliced in as a sibling cell of the same row (the reported behavior).
    expect(accountRow).not.toBe(identityRow);
    const rows = [...identityRow.closest('thead').rows];
    expect(rows.indexOf(accountRow)).toBeGreaterThan(rows.indexOf(identityRow));
  });

  it('fires the collapse/expand handlers from grouping cells', () => {
    const { handlers } = renderRich();
    fireEvent.click(screen.getAllByTitle('Expand Finance back into its columns')[0]);
    expect(handlers.onToggleCollapse).toHaveBeenCalledWith(['Finance', 'Payroll'], 0);

    fireEvent.click(screen.getByTitle('Collapse HR into one column'));
    expect(handlers.onToggleCollapse).toHaveBeenCalledWith(['HR', 'Recruiting'], 0);

    fireEvent.click(screen.getByTitle('Collapse Ops members back into a count'));
    expect(handlers.onToggleMembers).toHaveBeenCalledWith(['Ops', 'Logistics'], 0);
  });

  it('explodes an aggregate column from its name-row controls', () => {
    const { handlers } = renderRich();
    fireEvent.click(screen.getByTitle('Show all members here (direct + indirect)'));
    expect(handlers.onToggleMembers).toHaveBeenCalledWith(['Finance', 'Payroll'], 0, 'all');
    fireEvent.click(screen.getByTitle('Show direct members at this level only'));
    expect(handlers.onToggleMembers).toHaveBeenCalledWith(['Finance', 'Payroll'], 0, 'direct');
  });

  it('toggles an identity column and opens detail from a subject name', () => {
    const { handlers } = renderRich();
    fireEvent.click(screen.getByTitle('Collapse accounts')); // id1 is expanded
    expect(handlers.onToggleIdentity).toHaveBeenCalledWith('id1');

    fireEvent.click(screen.getByText('Alice'));
    expect(handlers.onOpenDetail).toHaveBeenCalledWith('identity', 'id1', 'Alice');

    fireEvent.click(screen.getByText('Bob · AAD'));
    expect(handlers.onOpenDetail).toHaveBeenCalledWith('user', 'acc1', 'Bob');
  });

  it('opens the access-package detail and sorts by count', () => {
    const { handlers } = renderRich();
    fireEvent.click(screen.getByText('Package One'));
    expect(handlers.onOpenDetail).toHaveBeenCalledWith('access-package', 'ap1', 'Package One');

    const countHeader = screen.getByTitle('Sort by member count (descending)');
    fireEvent.click(countHeader);
    expect(handlers.onSortByCount).toHaveBeenCalled();
  });
});
