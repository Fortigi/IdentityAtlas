// @vitest-environment jsdom
//
// AppMain owns the share dialog (#1166), and these are the tests that say why.
// Everything between the toolbar button that opens it and this level is torn
// down and rebuilt while the app works:
//
//   * a matrix refetch flips `loading`, replacing the entire body with the
//     loading pane;
//   * MatrixArea then picks RollupMatrixView / RotatedMatrixView / MatrixView
//     from the payload, so learning it is a roll-up swaps the view component.
//
// Either one destroyed a dialog living below it — which is exactly what an
// analyst on a slow tenant hit: "Share view…", start typing, and it vanished
// when the matrix caught up.

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// The views are heavy and irrelevant here; what matters is that they are
// DIFFERENT components, so React unmounts one to mount another. Each stub
// offers the same toolbar affordance the real ones do.
vi.mock('@ui/components/MatrixView', () => ({
  default: ({ onShareView }) => <button type="button" onClick={onShareView} data-testid="grid-view">Share view…</button>,
}));
vi.mock('@ui/components/RotatedMatrixView', () => ({
  default: ({ onShareView }) => <button type="button" onClick={onShareView} data-testid="rotated-view">Share view…</button>,
}));
vi.mock('@ui/components/RollupMatrixView', () => ({
  default: ({ onShareView }) => <button type="button" onClick={onShareView} data-testid="rollup-view">Share view…</button>,
}));
vi.mock('@ui/components/matrix/MatrixFilterWizard', () => ({ default: () => null }));
vi.mock('./DetailRoute', () => ({ default: () => <div data-testid="detail" /> }));

import AppMain from './AppMain';

const FILTER = { rowType: 'user', subject: { include: [] } };
const ROLLUP = { attribute: 'department', resources: [], groupValues: [], cells: [] };

// The load is driven from INSIDE the tree, the way the real app does it when a
// matrix payload lands — re-rendering from the test would tear down the
// providers too and prove nothing about the swap.
function Shell({ matrixFilter = FILTER, nextRollup = ROLLUP, ...rest }) {
  const [state, setState] = useState({ loading: false, rollup: null });
  return (
    <>
      <button type="button" onClick={() => setState({ loading: true, rollup: null })}>matrix refetches</button>
      <button type="button" onClick={() => setState({ loading: false, rollup: nextRollup })}>matrix payload arrives</button>
      <AppMain
        loading={state.loading}
        matrixProps={{ matrixFilter, managedFilter: 'all', rollup: state.rollup }}
        {...rest}
      />
    </>
  );
}

function renderShell(props = {}) {
  return renderWithProviders(<Shell {...props} />, {
    auth: {
      authFetch: makeAuthFetch({ '/api/users': { data: [] } }),
      permissions: new Set(['data.share']),
      hasWildcard: false,
      permissionsLoaded: true,
    },
  });
}

describe('AppMain', () => {
  it('swaps the body for the loading pane and back to the roll-up view', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(await screen.findByTestId('grid-view')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'matrix refetches' }));
    expect(screen.getByText('Loading permission data...')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'matrix payload arrives' }));
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();
  });

  it('keeps an open share dialog — and what was typed into it — through a refetch and a view swap', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByTestId('grid-view'));
    await user.type(await screen.findByRole('textbox', { name: /Name this view/i }), 'Sales team access');

    // The matrix refetches: the body becomes the loading pane…
    await user.click(screen.getByRole('button', { name: 'matrix refetches' }));
    expect(screen.getByText('Loading permission data...')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this view/i })).toHaveValue('Sales team access');

    // …and comes back as a roll-up, a different view component entirely.
    await user.click(screen.getByRole('button', { name: 'matrix payload arrives' }));
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();

    expect(screen.getByText('Share this matrix')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this view/i })).toHaveValue('Sales team access');
  });

  it('shares the matrix that is on screen, not a stale one', async () => {
    const user = userEvent.setup();
    const rotated = { ...FILTER, orientation: 'rows-as-subjects' };
    renderShell({ matrixFilter: rotated });

    await user.click(await screen.findByTestId('rotated-view'));
    expect(await screen.findByText('Share this matrix')).toBeInTheDocument();
  });

  it('closes the dialog on Cancel', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByTestId('grid-view'));
    expect(await screen.findByText('Share this matrix')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByText('Share this matrix')).not.toBeInTheDocument());
  });

  it('renders a detail route instead of the matrix when one is open', () => {
    renderShell({ isDetail: true, detailRouteProps: {} });
    expect(screen.getByTestId('detail')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });
});
