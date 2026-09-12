// @vitest-environment jsdom
//
// Admin → Experimental. What this pins down:
//   • the flag renders from /api/features (OFF is the state a fresh install sees)
//   • the experimental crawlers shipping in this build are listed by name
//   • the switch POSTs the right feature name and the flipped value
//   • the copy tells the operator that turning it off keeps existing crawlers
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import ExperimentalFeaturesSection from './ExperimentalFeaturesSection';
import { experimentalCrawlerTypes } from '@ui/utils/crawlerMetaRegistry';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
  waitFor,
} from '@ui/test-utils/renderWithProviders';

let reload;
beforeEach(() => {
  // The toggle hard-reloads so the Crawlers tab re-reads the flag; jsdom can't navigate.
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, hash: '' },
  });
});

// features/version arrive as props from App.jsx — the component fetches nothing.
const EDGE_VERSION = '5.649.20260908.1151';

function render(experimentalCrawlers, toggleResponse) {
  return renderWithProviders(
    h(ExperimentalFeaturesSection, {
      features: { riskScoring: false, accountLinking: true, experimentalCrawlers },
      version: EDGE_VERSION,
    }),
    { auth: { authFetch: makeAuthFetch({ '/api/admin/features/toggle': toggleResponse ?? {} }) } },
  );
}

describe('ExperimentalFeaturesSection', () => {
  it('shows the flag as Disabled and the switch as off when the feature is off', async () => {
    render(false);
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows the flag as Enabled when the feature is on', async () => {
    render(true);
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('lists the experimental crawlers this build ships, by name — so the switch says what it covers', async () => {
    // Read from the registry rather than naming a crawler: which types are
    // experimental changes over time, and app/ui/ must carry no type literals.
    const types = experimentalCrawlerTypes();
    expect(types.length).toBeGreaterThan(0);
    render(false);
    for (const t of types) {
      expect(await screen.findByText(t.name), t.id).toBeInTheDocument();
      expect(screen.getByText(t.description), t.id).toBeInTheDocument();
    }
  });

  it('explains that turning the flag off leaves an already-configured crawler running', async () => {
    render(true);
    expect(await screen.findByText(/does not disable an experimental crawler you already configured/i))
      .toBeInTheDocument();
  });

  it('turns the flag ON by posting experimentalCrawlers:true, then reloads', async () => {
    const { authFetch } = render(false);
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const [url, opts] = authFetch.mock.calls.find(([u]) => String(u).includes('/features/toggle'));
    expect(url).toContain('/api/admin/features/toggle');
    expect(JSON.parse(opts.body)).toEqual({ feature: 'experimentalCrawlers', enabled: true });
  });

  it('turns the flag OFF again by posting enabled:false', async () => {
    const { authFetch } = render(true);
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    await userEvent.click(toggle);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const [, opts] = authFetch.mock.calls.find(([u]) => String(u).includes('/features/toggle'));
    expect(JSON.parse(opts.body)).toEqual({ feature: 'experimentalCrawlers', enabled: false });
  });

  it('surfaces a failed toggle and does not reload', async () => {
    render(false, jsonResponse({ error: 'Feature toggle failed' }, { ok: false, status: 500 }));
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await userEvent.click(toggle);
    expect(await screen.findByText('Feature toggle failed')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('links to the experimental-features docs for the running build', async () => {
    render(false);
    const link = await screen.findByRole('link', { name: /Read more in the documentation/ });
    // An edge build (8-digit date segment) must link to /edge/, not /stable/.
    expect(link).toHaveAttribute(
      'href',
      'https://fortigi.github.io/IdentityAtlas/edge/reference/experimental-features/'
    );
  });
});
