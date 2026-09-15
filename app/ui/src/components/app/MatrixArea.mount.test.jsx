// @vitest-environment jsdom
//
// MatrixArea picks the matrix view. The views are stubbed — what is asserted is
// which one renders. (How the wizard opens is MatrixWizardHost's job, tested there.)
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/components/MatrixView', () => ({ default: () => <div data-testid="grid-view" /> }));
vi.mock('@ui/components/RotatedMatrixView', () => ({ default: () => <div data-testid="rotated-view" /> }));
vi.mock('@ui/components/RollupMatrixView', () => ({ default: () => <div data-testid="rollup-view" /> }));

import MatrixArea from './MatrixArea';

const FILTER = { rowType: 'principal', savedFilterId: 'sf-1' };

function renderArea(props) {
  renderWithProviders(
    <Suspense fallback={null}>
      <MatrixArea matrixFilter={FILTER} {...props} />
    </Suspense>,
  );
}

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
