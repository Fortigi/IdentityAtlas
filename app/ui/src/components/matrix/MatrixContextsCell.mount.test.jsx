// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MatrixContextsCell from './MatrixContextsCell';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const ctx = (displayName, contextType = 'group-category', variant = 'generated') =>
  ({ id: displayName, displayName, contextType, variant });

function renderCell(contexts) {
  return renderWithProviders(
    h('table', null, h('tbody', null, h('tr', null, h(MatrixContextsCell, { contexts })))),
  );
}

describe('MatrixContextsCell', () => {
  it('shows the first two contexts and a +N expander for the rest', async () => {
    renderCell([ctx('Finance', 'Tag', 'manual'), ctx('Microsoft 365'), ctx('Cluster-A', 'resource-cluster')]);

    expect(screen.getByText('Finance')).toBeTruthy();
    expect(screen.getByText('Microsoft 365')).toBeTruthy();
    expect(screen.queryByText('Cluster-A')).toBeNull();

    const more = screen.getByRole('button', { name: /show 1 more contexts/i });
    await userEvent.click(more);

    expect(screen.getByText('Cluster-A')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more contexts/i })).toBeNull();
  });

  it('renders both chips with no expander when the resource has exactly two', () => {
    renderCell([ctx('Finance'), ctx('Microsoft 365')]);
    expect(screen.getByText('Finance')).toBeTruthy();
    expect(screen.getByText('Microsoft 365')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more contexts/i })).toBeNull();
  });

  it('renders an em-dash empty state when the resource is in no contexts', () => {
    const { container } = renderCell([]);
    expect(container.querySelector('td').textContent).toBe('—');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to the empty state when the sidecar has no entry for the row', () => {
    const { container } = renderCell(undefined);
    expect(container.querySelector('td').textContent).toBe('—');
  });

  it('styles each chip by its context variant and titles it with the context type', () => {
    renderCell([ctx('Finance', 'Tag', 'manual'), ctx('Microsoft 365')]);
    // variantMeta() supplies theme-aware (dark-mode safe) classes — no hand-rolled colours.
    expect(screen.getByTitle('Finance (Tag)').className).toContain('text-amber-700');
    expect(screen.getByTitle('Microsoft 365 (group-category)').className).toContain('text-emerald-700');
  });
});
