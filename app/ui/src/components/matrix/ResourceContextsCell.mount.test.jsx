// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { fireEvent, within } from '@testing-library/react';
import ResourceContextsCell from './ResourceContextsCell';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const ctx = (id, displayName, contextType = 'Tag', variant = 'manual') =>
  ({ id, displayName, contextType, variant });

function renderCell(contexts) {
  return renderWithProviders(
    h('table', null, h('tbody', null, h('tr', null,
      h(ResourceContextsCell, { contexts })))),
  );
}

describe('ResourceContextsCell', () => {
  it('renders an em-dash empty state when the resource is in no contexts', () => {
    const { container } = renderCell(undefined);
    expect(container.querySelector('td').textContent).toBe('—');
  });

  it('shows both chips and no +N for exactly two contexts', () => {
    const { container, queryByRole } = renderCell([ctx('c1', 'Finance'), ctx('c2', 'M365')]);
    const cell = within(container.querySelector('td'));
    expect(cell.getByText('Finance')).toBeTruthy();
    expect(cell.getByText('M365')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });

  it('caps at 2 chips with a +N toggle that expands inline and collapses again', () => {
    const contexts = [ctx('c1', 'Finance'), ctx('c2', 'M365'), ctx('c3', 'Cluster-A')];
    const { container, getByRole, queryByText } = renderCell(contexts);
    const cell = within(container.querySelector('td'));

    // Collapsed: first 2 (server order) + "+1", third chip hidden.
    expect(cell.getByText('Finance')).toBeTruthy();
    expect(cell.getByText('M365')).toBeTruthy();
    expect(queryByText('Cluster-A')).toBeNull();

    const expand = getByRole('button', { name: /show 1 more context/i });
    expect(expand.textContent).toBe('+1');
    fireEvent.click(expand);

    // Expanded: all three chips, and a collapse control instead of +N.
    expect(cell.getByText('Cluster-A')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: /show fewer contexts/i }));
    expect(queryByText('Cluster-A')).toBeNull();
  });

  it('pluralises the accessible name for multiple hidden contexts', () => {
    const contexts = [ctx('c1', 'A'), ctx('c2', 'B'), ctx('c3', 'C'), ctx('c4', 'D')];
    const { getByRole } = renderCell(contexts);
    expect(getByRole('button', { name: /show 2 more contexts/i }).textContent).toBe('+2');
  });

  it('titles each chip with its context type', () => {
    const { container } = renderCell([ctx('c1', 'Finance', 'entra-group-category')]);
    const chip = container.querySelector('[title="Finance (entra-group-category)"]');
    expect(chip).toBeTruthy();
  });
});
