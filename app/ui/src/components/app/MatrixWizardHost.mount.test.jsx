// @vitest-environment jsdom
//
// MatrixWizardHost hands the wizard HOW it was asked to open (#1202): the matrix
// on screen (Adjust), a given step ("Unsaved changes" → the save step), or a
// fresh, empty matrix (New matrix). The wizard is stubbed — what is asserted is
// only what reaches it.
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const wizard = vi.hoisted(() => ({ props: null }));
vi.mock('@ui/components/matrix/MatrixFilterWizard', () => ({
  default: (props) => { wizard.props = props; return <div data-testid="wizard" />; },
}));

import MatrixWizardHost from './MatrixWizardHost';

const FILTER = { rowType: 'principal', savedFilterId: 'sf-1' };

async function renderHost(props) {
  wizard.props = null;
  renderWithProviders(
    <Suspense fallback={null}>
      <MatrixWizardHost matrixFilter={FILTER} managedFilter="gaps" wizardOpen onWizardApply={vi.fn()} onWizardClose={vi.fn()} {...props} />
    </Suspense>,
  );
  await screen.findByTestId('wizard');
  return wizard.props;
}

describe('MatrixWizardHost — opening the wizard', () => {
  it('opens on the matrix on screen, first step, when no mode is given', async () => {
    const props = await renderHost({});
    expect(props.open).toBe(true);
    expect(props.initialFilter).toBe(FILTER);
    expect(props.initialManaged).toBe('gaps');
    expect(props.initialStep).toBeUndefined();
  });

  it('opens on the step asked for, still on the matrix on screen', async () => {
    const props = await renderHost({ wizardMode: { step: 'share', fresh: false } });
    expect(props.initialStep).toBe('share');
    expect(props.initialFilter).toBe(FILTER);
    expect(props.initialManaged).toBe('gaps');
  });

  it('opens a fresh matrix with no filter and the governed toggle reset', async () => {
    const props = await renderHost({ wizardMode: { step: null, fresh: true } });
    expect(props.initialFilter).toBeNull();
    expect(props.initialManaged).toBe('all');
    expect(props.initialStep).toBeUndefined();
  });

  it('passes a closed wizard through as closed, never undefined', async () => {
    const props = await renderHost({ wizardOpen: undefined });
    expect(props.open).toBe(false);
  });
});
