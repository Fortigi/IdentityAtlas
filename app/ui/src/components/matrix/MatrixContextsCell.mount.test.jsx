// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MatrixContextsCell from './MatrixContextsCell';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const ctx = (id, displayName, contextType) => ({ id, displayName, contextType });

function renderCell(contexts) {
  return renderWithProviders(
    h('table', null, h('tbody', null, h('tr', null, h(MatrixContextsCell, { contexts })))),
  );
}

describe('MatrixContextsCell', () => {
  it('shows the first two contexts and collapses the rest behind a "+N" toggle', async () => {
    renderCell([
      ctx('c1', 'Finance', 'Tag'),
      ctx('c2', 'Microsoft 365', 'group-category'),
      ctx('c3', 'Cluster-A', 'cluster'),
    ]);

    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    expect(screen.queryByText('Cluster-A')).not.toBeInTheDocument();

    const expand = screen.getByRole('button', { name: /show 1 more contexts/i });
    await userEvent.click(expand);
    expect(screen.getByText('Cluster-A')).toBeInTheDocument();

    // …and collapses again.
    await userEvent.click(screen.getByRole('button', { name: /show fewer contexts/i }));
    expect(screen.queryByText('Cluster-A')).not.toBeInTheDocument();
  });

  it('shows both chips with no toggle when the resource is in exactly two contexts', () => {
    renderCell([ctx('c1', 'Finance', 'Tag'), ctx('c2', 'Microsoft 365', 'group-category')]);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an em dash when the resource is in no contexts', () => {
    renderCell([]);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('tolerates a missing contexts list', () => {
    renderCell(undefined);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('titles each chip with its context type', () => {
    renderCell([ctx('c1', 'Finance', 'Tag'), ctx('c2', 'Nameless', undefined)]);
    expect(screen.getByText('Finance')).toHaveAttribute('title', 'Tag: Finance');
    expect(screen.getByText('Nameless')).toHaveAttribute('title', 'Context: Nameless');
  });
});
