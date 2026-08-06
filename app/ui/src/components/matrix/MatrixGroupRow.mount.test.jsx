// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixGroupRow from './MatrixGroupRow';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const users = [
  { id: 'u1', displayName: 'Alice' },
  { id: 'u2', displayName: 'Bob' },
];

function renderRow(group, extraProps = {}) {
  return renderWithProviders(
    h('table', null, h('tbody', null,
      h(MatrixGroupRow, {
        group,
        users,
        totalUsers: users.length,
        memberships: new Map([[`${group.id}|u1`, new Set(['Direct'])]]),
        ...extraProps,
      }),
    )),
  );
}

describe('MatrixGroupRow metadata columns', () => {
  it('pins Contexts next to the resource name and puts Type on the right', () => {
    const { container } = renderRow({
      id: 'g1', displayName: 'Admins', groupType: 'Group', description: 'All admins', memberCount: 1,
      contexts: [
        { id: 'c1', displayName: 'Finance', contextType: 'Tag' },
        { id: 'c2', displayName: 'Microsoft 365', contextType: 'group-category' },
        { id: 'c3', displayName: 'Cluster-A', contextType: 'cluster' },
      ],
    });

    const cells = [...container.querySelectorAll('td')];
    // drag handle + name + contexts + one cell per subject + # | Type | Description
    expect(cells.length).toBe(3 + users.length + 3);

    // Contexts is the third sticky cell, offset past the drag handle + name.
    const contextsCell = cells[2];
    expect(contextsCell.style.left).toBe('299px');
    expect(contextsCell.className).toContain('sticky');
    expect(contextsCell).toHaveTextContent('Finance');
    expect(screen.getByRole('button', { name: /show 1 more contexts/i })).toBeInTheDocument();

    // Type now sits in the right-side metadata block, between # and Description.
    expect(cells[cells.length - 3]).toHaveTextContent('1');       // member count
    expect(cells[cells.length - 2]).toHaveTextContent('Group');   // Type
    expect(cells[cells.length - 2].className).not.toContain('sticky');
    expect(cells[cells.length - 1]).toHaveTextContent('All admins');
  });

  it('renders an empty Contexts cell for a resource in no contexts', () => {
    renderRow({ id: 'g2', displayName: 'Readers', groupType: 'Group', description: '', memberCount: 0 });
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByTitle('Group')).toHaveTextContent('Group');
  });
});

describe('MatrixGroupRow access-package cells', () => {
  const accessPackages = [
    { id: 'ap1', displayName: 'PCM - Piket bevoegdheden' },
    { id: 'ap2', displayName: 'Package Two' },
  ];

  // The badge letter must match what exportToExcel writes for the same role
  // name — both read the shared getApRoleBadge (issue #942).
  it.each([
    ['Member', 'D'],
    ['Owner', 'D'],
    ['Eligible Member', 'E'],
  ])('badges a "%s" role scope as %s', (roleName, letter) => {
    renderRow(
      { id: 'g1', displayName: 'PCM - Piket bevoegdheden', groupType: 'Group', description: '', memberCount: 1 },
      { accessPackages, apGroupMap: new Map([['G1|ap1', roleName]]) },
    );

    expect(screen.getByTitle(`PCM - Piket bevoegdheden (${roleName})`)).toHaveTextContent(letter);
    // The unmapped package's cell stays blank.
    expect(screen.queryByTitle(/^Package Two/)).toBeNull();
  });
});
