// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixGroupRow from './MatrixGroupRow';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const users = [
  { id: 'u1', displayName: 'Alice' },
  { id: 'u2', displayName: 'Bob' },
];

function renderRow(group) {
  return renderWithProviders(
    h('table', null, h('tbody', null,
      h(MatrixGroupRow, {
        group,
        users,
        totalUsers: users.length,
        memberships: new Map([[`${group.id}|u1`, new Set(['Direct'])]]),
      }),
    )),
  );
}

describe('MatrixGroupRow right-side metadata', () => {
  it('renders the Contexts cell between the member count and the description', () => {
    const { container } = renderRow({
      id: 'g1', displayName: 'Admins', groupType: 'Group', description: 'All admins', memberCount: 1,
      contexts: [
        { id: 'c1', displayName: 'Finance', contextType: 'Tag' },
        { id: 'c2', displayName: 'Microsoft 365', contextType: 'group-category' },
        { id: 'c3', displayName: 'Cluster-A', contextType: 'cluster' },
      ],
    });

    // drag handle + name + type + one cell per subject + # | Contexts | Description
    expect(container.querySelectorAll('td').length).toBe(3 + users.length + 3);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show 1 more contexts/i })).toBeInTheDocument();
    expect(screen.getByText('All admins')).toBeInTheDocument();
  });

  it('renders an empty Contexts cell for a resource in no contexts', () => {
    renderRow({ id: 'g2', displayName: 'Readers', groupType: 'Group', description: '', memberCount: 0 });
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
