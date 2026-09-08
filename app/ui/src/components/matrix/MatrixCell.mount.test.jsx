// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MatrixCell from './MatrixCell';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

const renderCell = (props = {}) =>
  renderWithProviders(
    h('table', null, h('tbody', null, h('tr', { onClick: vi.fn() },
      h(MatrixCell, { cellKey: 'u1|g1', ...props })))),
  );

const EXPLAIN = /explain inherited access/i;

describe('MatrixCell — Indirect badge', () => {
  it('is operable by Enter and Space, not just focusable', async () => {
    const onExplainInherited = vi.fn();
    renderCell({ membershipTypes: new Set(['Indirect']), onExplainInherited });

    const badge = screen.getByRole('button', { name: EXPLAIN });
    badge.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    // The badge used to carry role="button" + tabIndex with no key handler —
    // reachable but dead. Both keys must open the explainer.
    expect(onExplainInherited).toHaveBeenCalledTimes(2);
    expect(onExplainInherited).toHaveBeenCalledWith('u1|g1');
  });

  it('does not let the explainer click bubble out to the row', async () => {
    const onExplainInherited = vi.fn();
    const onRowClick = vi.fn();
    renderWithProviders(
      h('table', null, h('tbody', null, h('tr', { onClick: onRowClick },
        h(MatrixCell, { cellKey: 'u1|g1', membershipTypes: new Set(['Indirect']), onExplainInherited })))),
    );

    await userEvent.click(screen.getByRole('button', { name: EXPLAIN }));
    expect(onExplainInherited).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('leaves an Indirect badge inert when no explainer handler is supplied', () => {
    renderCell({ membershipTypes: new Set(['Indirect']) });

    // Zero case: no handler → no role, no tab stop. A matrix is thousands of
    // cells; inert ones must not each become a focus stop.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('[tabindex]')).toBeNull();
    expect(screen.getByText('I')).toBeInTheDocument();
  });

  it('leaves Direct and Eligible badges non-interactive even with a handler', () => {
    renderCell({ membershipTypes: new Set(['Direct', 'Eligible']), onExplainInherited: vi.fn() });

    // Only inherited access has a path to explain; making every swatch a
    // control would flood the tab order with no-ops.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('renders an unknown membership type as a plain "?" swatch', () => {
    renderCell({ membershipTypes: new Set(['Bogus']), onExplainInherited: vi.fn() });
    expect(screen.getByText('?')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an empty cell with no badges at all', () => {
    renderCell({ membershipTypes: new Set() });
    expect(screen.getByRole('cell')).toHaveTextContent('');
  });
});
