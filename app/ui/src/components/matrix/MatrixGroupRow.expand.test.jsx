// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixGroupRow from './MatrixGroupRow';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';

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
        memberships: new Map(),
        ...extraProps,
      }),
    )),
  );
}

const baseGroup = {
  id: 'g1', displayName: 'Admins', groupType: 'Group', description: '', memberCount: 2,
};

describe('MatrixGroupRow nested-group expansion', () => {
  it('shows a collapsed expand toggle for an expandable group', () => {
    const onToggleExpand = vi.fn();
    renderRow(baseGroup, {
      groupsWithNested: new Set(['g1']),
      expandedGroups: new Set(),
      loadingNested: new Set(),
      onToggleExpand,
    });

    const btn = screen.getByTitle('Expand nested groups');
    expect(btn).toHaveTextContent('▶');
    fireEvent.click(btn);
    expect(onToggleExpand).toHaveBeenCalledWith('g1');
  });

  it('shows an expanded toggle when the group is expanded', () => {
    renderRow(baseGroup, {
      groupsWithNested: new Set(['g1']),
      expandedGroups: new Set(['g1']),
      loadingNested: new Set(),
    });

    expect(screen.getByTitle('Collapse nested groups')).toHaveTextContent('▼');
  });

  it('shows a spinner while nested groups are loading', () => {
    const { container } = renderRow(baseGroup, {
      groupsWithNested: new Set(['g1']),
      expandedGroups: new Set(),
      loadingNested: new Set(['g1']),
    });

    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('renders a connector glyph and no grab cursor for a nested row', () => {
    const { container } = renderRow(
      { ...baseGroup, id: 'g1-child', realGroupId: 'g1', isNestedRow: true, nestLevel: 1 },
    );

    expect(screen.getByText('└')).toBeInTheDocument();
    const handleCell = container.querySelector('td');
    expect(handleCell.className).not.toContain('cursor-grab');
  });

  it('opens the resource detail when the name is clicked', () => {
    const onOpenDetail = vi.fn();
    renderRow(baseGroup, { onOpenDetail });

    fireEvent.click(screen.getByText('Admins'));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'Admins');
  });
});

describe('MatrixGroupRow aggregate column', () => {
  const aggUsers = [{ id: 'uAgg', displayName: 'Sales', isAggregateCol: true }];

  function renderAgg(counts) {
    return renderWithProviders(
      h('table', null, h('tbody', null,
        h(MatrixGroupRow, {
          group: baseGroup,
          users: aggUsers,
          totalUsers: 1,
          memberships: new Map(),
          aggDirectCounts: counts,
        }),
      )),
    );
  }

  it('renders the direct-assignment count for a folded attribute group', () => {
    renderAgg(new Map([['g1 uAgg', 4]]));
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders a dot when a folded attribute group has no direct assignments', () => {
    renderAgg(new Map());
    expect(screen.getByText('·')).toBeInTheDocument();
  });
});
