// @vitest-environment jsdom
//
// MatrixArea picks the matrix view. The views are stubbed — what is asserted is
// which one renders, and what it is handed. (How the wizard opens is
// MatrixWizardHost's job, tested there.)
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

// The grid stub offers the "+ Proposed roles" toggle the way the real toolbar does.
vi.mock('@ui/components/MatrixView', () => ({
  default: ({ showProposed, managedFilter, onToggleProposed }) => (
    <div data-testid="grid-view" data-proposed={String(!!showProposed)} data-lens={managedFilter}>
      {showProposed && <button type="button" onClick={() => onToggleProposed(true)}>+ Proposed roles</button>}
    </div>
  ),
}));
vi.mock('@ui/components/matrix/ProposedMatrix', () => ({
  default: ({ managedFilter, data, managedByPackages, onToggleProposed }) => (
    <div data-testid="proposed-view" data-lens={managedFilter} data-rows={data?.length} data-covered={managedByPackages?.length}>
      <button type="button" onClick={() => onToggleProposed(false)}>Hide proposed</button>
    </div>
  ),
}));
vi.mock('@ui/components/RotatedMatrixView', () => ({ default: () => <div data-testid="rotated-view" /> }));
vi.mock('@ui/components/RollupMatrixView', () => ({ default: () => <div data-testid="rollup-view" /> }));

import MatrixArea from './MatrixArea';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';

const FILTER = { rowType: 'principal', savedFilterId: 'sf-1' };
const DATA = [{ memberId: 'm1', resourceId: 'r1' }, { memberId: 'm2', resourceId: 'r1' }];
const COVERED = [{ memberId: 'm1', resourceId: 'r1', accessPackageIds: ['br'] }];

function renderArea(props, { shared = false, auth, knowledge = true } = {}) {
  renderWithProviders(
    <SharedViewContext.Provider value={shared}>
      <Suspense fallback={null}>
        <MatrixArea matrixFilter={FILTER} data={DATA} managedByPackages={COVERED} {...props} />
      </Suspense>
    </SharedViewContext.Provider>,
    { ...(auth ? { auth } : {}), features: { orgKnowledge: knowledge } },
  );
}

const READ_ONLY = { hasWildcard: false, permissions: new Set(['data.read']) };

describe('MatrixArea — "+ Proposed roles", on top of any lens', () => {
  it('offers it to an analyst who may write contexts; off, the plain grid', async () => {
    renderArea({ managedFilter: 'all' });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('true');
    expect(screen.queryByTestId('proposed-view')).not.toBeInTheDocument();
  });

  it('adds the proposals to the lens chosen — the same data and lens — and turns off again', async () => {
    const user = userEvent.setup();
    for (const lens of ['all', 'managed', 'unmanaged', 'gaps']) {
      const { unmount } = renderWithProviders(
        <Suspense fallback={null}><MatrixArea matrixFilter={FILTER} data={DATA} managedByPackages={COVERED} managedFilter={lens} /></Suspense>,
        { features: { orgKnowledge: true } });
      await user.click(await screen.findByRole('button', { name: '+ Proposed roles' }));
      const view = await screen.findByTestId('proposed-view');
      expect(view.dataset).toMatchObject({ lens, rows: '2', covered: '1' });
      expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Hide proposed' }));
      expect((await screen.findByTestId('grid-view')).dataset.lens).toBe(lens);
      unmount();
    }
  });

  it('never offers it in a shared view', async () => {
    renderArea({ managedFilter: 'all' }, { shared: true });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('false');
    expect(screen.queryByRole('button', { name: '+ Proposed roles' })).toBeNull();
  });

  it('never offers it while organisation knowledge is off', async () => {
    renderArea({ managedFilter: 'all' }, { knowledge: false });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('false');
  });

  it('never offers it to someone who may not write contexts', async () => {
    renderArea({ managedFilter: 'all' }, { auth: READ_ONLY });
    expect((await screen.findByTestId('grid-view')).dataset.proposed).toBe('false');
  });

  it('leaves All, Governed, Non-governed and Gaps on the grid as before while it is off', async () => {
    for (const lens of ['all', 'managed', 'unmanaged', 'gaps']) {
      const { unmount } = renderWithProviders(<Suspense fallback={null}><MatrixArea matrixFilter={FILTER} managedFilter={lens} /></Suspense>, { features: { orgKnowledge: true } });
      expect((await screen.findByTestId('grid-view')).dataset.lens).toBe(lens);
      expect(screen.queryByTestId('proposed-view')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the roll-up and rotated views as they are', async () => {
    renderArea({ managedFilter: 'all', rollup: { attribute: 'department' } });
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
