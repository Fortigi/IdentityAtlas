// @vitest-environment jsdom
//
// MatrixArea picks the matrix view. The views are stubbed — what is asserted is
// which one renders. (How the wizard opens is MatrixWizardHost's job, tested there.)
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/components/MatrixView', () => ({
  default: ({ showProposed, managedFilter }) => <div data-testid="grid-view" data-proposed={String(!!showProposed)} data-lens={managedFilter} />,
}));
vi.mock('@ui/components/matrix/ProposedMatrix', () => ({ default: () => <div data-testid="proposed-view" /> }));
vi.mock('@ui/components/RotatedMatrixView', () => ({ default: () => <div data-testid="rotated-view" /> }));
vi.mock('@ui/components/RollupMatrixView', () => ({ default: () => <div data-testid="rollup-view" /> }));

import MatrixArea from './MatrixArea';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';

const FILTER = { rowType: 'principal', savedFilterId: 'sf-1' };

function renderArea(props, { shared = false, auth } = {}) {
  renderWithProviders(
    <SharedViewContext.Provider value={shared}>
      <Suspense fallback={null}>
        <MatrixArea matrixFilter={FILTER} {...props} />
      </Suspense>
    </SharedViewContext.Provider>,
    auth ? { auth } : undefined,
  );
}

const READ_ONLY = { hasWildcard: false, permissions: new Set(['data.read']) };

describe('MatrixArea — the Proposed lens', () => {
  it('offers it to an analyst who may write contexts', async () => {
    renderArea({ managedFilter: 'all' });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('true');
  });

  it('renders the proposed matrix when the lens is Proposed', async () => {
    renderArea({ managedFilter: 'proposed' });
    expect(await screen.findByTestId('proposed-view')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });

  it('never offers it in a shared view, and falls back to the grid there', async () => {
    renderArea({ managedFilter: 'proposed' }, { shared: true });
    const grid = await screen.findByTestId('grid-view');
    expect(grid.dataset.proposed).toBe('false');
    expect(screen.queryByTestId('proposed-view')).not.toBeInTheDocument();
  });

  it('never offers it to someone who may not write contexts', async () => {
    renderArea({ managedFilter: 'proposed' }, { auth: READ_ONLY });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('false');
  });

  it('leaves All, Governed, Non-governed and Gaps on the grid as before', async () => {
    for (const lens of ['all', 'managed', 'unmanaged', 'gaps']) {
      const { unmount } = renderWithProviders(<Suspense fallback={null}><MatrixArea matrixFilter={FILTER} managedFilter={lens} /></Suspense>);
      expect((await screen.findByTestId('grid-view')).dataset.lens).toBe(lens);
      expect(screen.queryByTestId('proposed-view')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the roll-up and rotated views on Proposed', async () => {
    renderArea({ managedFilter: 'proposed', rollup: { attribute: 'department' } });
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();
    expect(screen.queryByTestId('proposed-view')).not.toBeInTheDocument();
  });
});

describe('MatrixArea — which view', () => {
  it('renders the grid for a subjects-as-columns matrix', async () => {
    renderArea({});
    expect(await screen.findByTestId('grid-view')).toBeInTheDocument();
  });

  it('renders the rotated view for a subjects-as-rows matrix', async () => {
    renderArea({ matrixFilter: { ...FILTER, orientation: 'rows-as-subjects' } });
    expect(await screen.findByTestId('rotated-view')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });

  it('renders the roll-up view when the payload is a roll-up', async () => {
    renderArea({ rollup: { attribute: 'department' } });
    expect(await screen.findByTestId('rollup-view')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });
});
