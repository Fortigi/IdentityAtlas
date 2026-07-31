// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixContextsCell from './MatrixContextsCell';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const ctx = (name, over = {}) => ({
  id: name.toLowerCase().replace(/\s/g, '-'),
  displayName: name,
  contextType: 'tag',
  variant: 'manual',
  ...over,
});

// <td> must sit inside a table row to render validly.
function renderCell(contexts) {
  return renderWithProviders(
    h('table', null, h('tbody', null, h('tr', null,
      h(MatrixContextsCell, { contexts })))),
  );
}

describe('MatrixContextsCell', () => {
  it('renders an em-dash empty state for a resource in no contexts', () => {
    renderCell([]);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows both chips and no expand control at exactly two contexts', () => {
    renderCell([ctx('Finance'), ctx('M365', { variant: 'generated' })]);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('M365')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('caps at two chips with an accessible +N toggle that expands inline and collapses back', async () => {
    renderCell([ctx('Finance'), ctx('M365'), ctx('Cluster A')]);
    const user = userEvent.setup();

    // Collapsed: first two (server order) + the +1 control; the third is hidden.
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('M365')).toBeInTheDocument();
    expect(screen.queryByText('Cluster A')).not.toBeInTheDocument();

    const expandBtn = screen.getByRole('button', { name: /show 1 more contexts/i });
    expect(expandBtn).toHaveTextContent('+1');
    await user.click(expandBtn);

    // Expanded: all three visible, control flips to a collapse affordance.
    expect(screen.getByText('Cluster A')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show fewer contexts/i }));
    expect(screen.queryByText('Cluster A')).not.toBeInTheDocument();
  });

  it('titles each chip with its context type', () => {
    renderCell([ctx('Finance', { contextType: 'group-category' })]);
    expect(screen.getByTitle('Finance (group-category)')).toBeInTheDocument();
  });
});
