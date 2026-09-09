// @vitest-environment jsdom
//
// MatrixArea owns the share dialog (#1166). It has to, and this is the test
// that says why: which of the three matrix views renders is decided by the
// data, so a roll-up payload landing mid-session swaps the whole view — and
// anything living inside it is destroyed. The share dialog used to live in the
// toolbar button, so a slow matrix finishing its first load closed the dialog
// under the analyst's hands and threw away what they had typed.

import { describe, it, expect, vi } from 'vitest';
import { Suspense, useState } from 'react';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// The views themselves are heavy and irrelevant here — all that matters is
// that they are DIFFERENT components, so React unmounts one to mount another.
// Each stub offers the same toolbar affordance the real ones do.
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

import MatrixArea from './MatrixArea';

const FILTER = { rowType: 'user', subject: { include: [] } };
const ROLLUP = { attribute: 'department', resources: [], groupValues: [], cells: [] };

// The swap is driven from INSIDE the tree, the way the real page does it when a
// matrix payload lands — re-rendering from the test would tear down the
// providers too and prove nothing about the view swap.
function Area({ matrixFilter = FILTER, ...props }) {
  const [rollup, setRollup] = useState(null);
  return (
    <>
      <button type="button" onClick={() => setRollup(ROLLUP)}>matrix payload arrives</button>
      <Suspense fallback={null}>
        <MatrixArea rollup={rollup} matrixFilter={matrixFilter} managedFilter="all" {...props} />
      </Suspense>
    </>
  );
}

function renderArea(props = {}) {
  return renderWithProviders(<Area {...props} />, {
    auth: {
      authFetch: makeAuthFetch({ '/api/users': { data: [] } }),
      permissions: new Set(['data.share']),
      hasWildcard: false,
      permissionsLoaded: true,
    },
  });
}

describe('MatrixArea', () => {
  it('renders the grid view until roll-up data arrives, then the roll-up view', async () => {
    const user = userEvent.setup();
    renderArea();
    expect(await screen.findByTestId('grid-view')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'matrix payload arrives' }));
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });

  it('keeps an open share dialog — and what was typed into it — when the view swaps under it', async () => {
    const user = userEvent.setup();
    renderArea();

    await user.click(await screen.findByTestId('grid-view'));
    await user.type(await screen.findByRole('textbox', { name: /Name this view/i }), 'Sales team access');

    // The matrix finishes loading and decides it is a roll-up after all: the
    // view the button lives in is torn down and a different one mounts.
    await user.click(screen.getByRole('button', { name: 'matrix payload arrives' }));
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();

    // The dialog is untouched by that — including the half-finished input.
    expect(screen.getByText('Share this matrix')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this view/i })).toHaveValue('Sales team access');
  });

  it('closes the dialog on Cancel', async () => {
    const user = userEvent.setup();
    renderArea();

    await user.click(await screen.findByTestId('grid-view'));
    expect(await screen.findByText('Share this matrix')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByText('Share this matrix')).not.toBeInTheDocument());
  });

  it('shares the rotated view when that is the orientation on screen', async () => {
    const user = userEvent.setup();
    renderArea({ matrixFilter: { ...FILTER, orientation: 'rows-as-subjects' } });

    await user.click(await screen.findByTestId('rotated-view'));
    expect(await screen.findByText('Share this matrix')).toBeInTheDocument();
  });
});
