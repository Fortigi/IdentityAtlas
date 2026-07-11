// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import RiskScoreSection from './RiskScoreSection';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, userEvent } from '@ui/test-utils/renderWithProviders';

const baseAttrs = {
  riskScore: 82,
  riskTier: 'High',
  riskScoredAt: '2026-06-01T10:00:00Z',
  riskDirectScore: 40,
  riskMembershipScore: 15,
  riskStructuralScore: 5,
  riskPropagatedScore: 22,
  riskClassifierMatches: JSON.stringify([{ score: 75, category: 'PrivilegedRole', rationale: 'has admin role' }]),
  riskExplanation: JSON.stringify({ direct: { reasons: ['matched privileged role'] } }),
  riskOverride: null,
  riskOverrideReason: null,
};

function render(attrs = baseAttrs, authFetch = makeAuthFetch({})) {
  return renderWithProviders(
    h(RiskScoreSection, { attributes: attrs, entityType: 'user', entityId: 'u1', authFetch }),
  );
}

describe('RiskScoreSection (mounted)', () => {
  it('renders nothing when there is no risk data', () => {
    const { container } = render({});
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the tier, score and layer breakdown', () => {
    render();
    expect(screen.getByText('Risk Assessment')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Classifier Match')).toBeInTheDocument();
    expect(screen.getByText('Risk Propagation')).toBeInTheDocument();
    expect(screen.getByText('82')).toBeInTheDocument(); // score readout
  });

  it('colours the score bar from the backend tier (shared TIER_STYLES, not a client cutoff)', () => {
    // The bar's fill colour must come from the tier via TIER_STYLES so it can't
    // drift from the badge or the engine's tierFor thresholds.
    const { container } = render({ ...baseAttrs, riskTier: 'High' });
    const bar = container.querySelector('.h-full.rounded-full');
    expect(bar).toBeTruthy();
    expect(bar.className).toContain('bg-orange-500'); // TIER_STYLES.High.dot

    const { container: crit } = render({ ...baseAttrs, riskTier: 'Critical' });
    expect(crit.querySelector('.h-full.rounded-full').className).toContain('bg-red-500'); // TIER_STYLES.Critical.dot
  });

  it('toggles the details panel showing classifier matches and explanation', async () => {
    render();
    const user = userEvent.setup();
    await user.click(screen.getByText('Show Details'));

    expect(screen.getByText('Classifier Matches')).toBeInTheDocument();
    expect(screen.getByText('has admin role')).toBeInTheDocument();
    expect(screen.getByText('matched privileged role')).toBeInTheDocument();

    await user.click(screen.getByText('Hide Details'));
    expect(screen.queryByText('Classifier Matches')).not.toBeInTheDocument();
  });

  it('saves an analyst override via authFetch and shows the override badge', async () => {
    const authFetch = makeAuthFetch({ '/override': jsonResponse({ ok: true }) });
    const { container } = render(baseAttrs, authFetch);
    const user = userEvent.setup();

    await user.click(screen.getByText('Adjust Score'));

    // Move the range slider and provide a reason (both required to enable Save).
    fireEvent.change(container.querySelector('input[type="range"]'), { target: { value: '10' } });
    await user.type(screen.getByPlaceholderText(/Explain why/i), 'elevated due to audit finding');
    await user.click(screen.getByText('Save Override'));

    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-scores/users/u1/override',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(await screen.findByText('override: +10')).toBeInTheDocument();
  });

  it('removes an existing override', async () => {
    const authFetch = makeAuthFetch({ '/override': jsonResponse({ ok: true }) });
    render({ ...baseAttrs, riskOverride: 15, riskOverrideReason: 'manual bump' }, authFetch);
    const user = userEvent.setup();

    await user.click(screen.getByText('Edit Override'));
    await user.click(screen.getByText('Remove Override'));

    expect(authFetch).toHaveBeenCalledWith(
      '/api/risk-scores/users/u1/override',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
