// @vitest-environment jsdom
//
// MatrixArea hands the wizard HOW it was asked to open (#1202): the matrix on
// screen (Adjust), a given step ("Unsaved changes" → the save step), or a fresh,
// empty matrix (New matrix). The views and the wizard are stubbed — what is
// asserted is only what reaches the wizard.
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const wizard = vi.hoisted(() => ({ props: null }));
vi.mock('@ui/components/MatrixView', () => ({ default: () => <div data-testid="grid-view" /> }));
vi.mock('@ui/components/RotatedMatrixView', () => ({ default: () => <div data-testid="rotated-view" /> }));
vi.mock('@ui/components/RollupMatrixView', () => ({ default: () => <div data-testid="rollup-view" /> }));
vi.mock('@ui/components/matrix/MatrixFilterWizard', () => ({
  default: (props) => { wizard.props = props; return <div data-testid="wizard" />; },
}));

import MatrixArea from './MatrixArea';

const FILTER = { rowType: 'principal', savedFilterId: 'sf-1' };

async function renderArea(props) {
  wizard.props = null;
  renderWithProviders(
    <Suspense fallback={null}>
      <MatrixArea matrixFilter={FILTER} managedFilter="gaps" wizardOpen onWizardApply={vi.fn()} onWizardClose={vi.fn()} {...props} />
    </Suspense>,
  );
  await screen.findByTestId('wizard');
  await screen.findByTestId('grid-view');
  return wizard.props;
}

describe('MatrixArea — opening the wizard', () => {
  it('opens on the matrix on screen, first step, when no mode is given', async () => {
    const props = await renderArea({});
    expect(props.open).toBe(true);
    expect(props.initialFilter).toBe(FILTER);
    expect(props.initialManaged).toBe('gaps');
    expect(props.initialStep).toBeUndefined();
  });

  it('opens on the step asked for, still on the matrix on screen', async () => {
    const props = await renderArea({ wizardMode: { step: 'share', fresh: false } });
    expect(props.initialStep).toBe('share');
    expect(props.initialFilter).toBe(FILTER);
    expect(props.initialManaged).toBe('gaps');
  });

  it('opens a fresh matrix with no filter and the governed toggle reset', async () => {
    const props = await renderArea({ wizardMode: { step: null, fresh: true } });
    expect(props.initialFilter).toBeNull();
    expect(props.initialManaged).toBe('all');
    expect(props.initialStep).toBeUndefined();
  });

  it('renders the rotated view for a subjects-as-rows matrix', async () => {
    renderWithProviders(
      <Suspense fallback={null}>
        <MatrixArea matrixFilter={{ ...FILTER, orientation: 'rows-as-subjects' }} wizardOpen={false} />
      </Suspense>,
    );
    expect(await screen.findByTestId('rotated-view')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view')).not.toBeInTheDocument();
  });
});
