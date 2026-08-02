// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixGroupRow from './MatrixGroupRow';
import { buildResourceContextsMap } from '@ui/utils/matrixContexts';
import { renderWithProviders, screen, fireEvent, within } from '@ui/test-utils/renderWithProviders';

const ctx = (id, displayName, contextType = 'Tag', variant = 'manual') =>
  ({ id, displayName, contextType, variant });

function renderRow({ group, resourceContexts = [] } = {}) {
  const g = group || { id: 'g1', displayName: 'Admins', groupType: 'Group', description: 'the admins', memberCount: 3 };
  return renderWithProviders(
    h('table', null, h('tbody', null,
      h(MatrixGroupRow, {
        group: g,
        users: [],
        totalUsers: 0,
        memberships: new Map(),
        accessPackages: [],
        resourceContextsMap: buildResourceContextsMap(resourceContexts),
      }))),
  );
}

describe('MatrixGroupRow — Contexts column', () => {
  it('renders the — empty state when the resource is in no contexts', () => {
    renderRow();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more contexts/i })).toBeNull();
  });

  it('shows both chips with no +N when the resource is in exactly 2 contexts', () => {
    renderRow({ resourceContexts: [
      { resourceId: 'g1', contexts: [ctx('c1', 'Finance'), ctx('c2', 'M365', 'group-category', 'generated')] },
    ] });
    expect(screen.getByText('Finance')).toBeTruthy();
    expect(screen.getByText('M365')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more contexts/i })).toBeNull();
  });

  it('caps at 2 chips + a +N toggle that expands inline and collapses again', () => {
    renderRow({ resourceContexts: [
      { resourceId: 'g1', contexts: [
        ctx('c1', 'Finance'),
        ctx('c2', 'M365', 'group-category', 'generated'),
        ctx('c3', 'Cluster-A', 'resource-cluster', 'generated'),
      ] },
    ] });

    // Spec fixture: "Finance, M365  +1" — third chip hidden.
    expect(screen.getByText('Finance')).toBeTruthy();
    expect(screen.getByText('M365')).toBeTruthy();
    expect(screen.queryByText('Cluster-A')).toBeNull();

    const expand = screen.getByRole('button', { name: 'Show 1 more contexts' });
    expect(expand.textContent).toBe('+1');
    fireEvent.click(expand);
    expect(screen.getByText('Cluster-A')).toBeTruthy();

    const collapse = screen.getByRole('button', { name: 'Show fewer contexts' });
    fireEvent.click(collapse);
    expect(screen.queryByText('Cluster-A')).toBeNull();
  });

  it('resolves contexts through realGroupId for synthetic rows and titles chips with the context type', () => {
    renderRow({
      group: { id: 'parent__nested__real-1', realGroupId: 'real-1', displayName: 'Nested', groupType: 'Group', description: '', memberCount: 1, isNestedRow: true, nestLevel: 1 },
      resourceContexts: [{ resourceId: 'real-1', contexts: [ctx('c1', 'Finance')] }],
    });
    const chipText = screen.getByText('Finance');
    const chip = chipText.closest('span[title]');
    expect(within(chip.parentElement).getByText('Finance')).toBeTruthy();
    expect(chip.getAttribute('title')).toBe('Finance (Tag)');
  });
});
