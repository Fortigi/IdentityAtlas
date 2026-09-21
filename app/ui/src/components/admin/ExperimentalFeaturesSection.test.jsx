// @vitest-environment jsdom
//
// Admin → Experimental. What this pins down:
//   • the flag renders from the features prop App.jsx passes down (OFF is the
//     state a fresh install sees)
//   • the experimental crawlers shipping in this build are listed by name
//   • the switch POSTs the right feature name and the flipped value
//   • the copy tells the operator that turning it off keeps existing crawlers
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// matrixSharing defaults to the OPPOSITE of experimentalCrawlers, so the two
// cards never agree: a switch wired to the wrong flag shows the wrong state.
// customReports and contextAssistant follow matrixSharing for the same reason.
function render(experimentalCrawlers, toggleResponse, matrixSharing = !experimentalCrawlers) {
  return renderWithProviders(
    h(ExperimentalFeaturesSection, {
      features: { riskScoring: false, accountLinking: true, experimentalCrawlers, matrixSharing, customReports: matrixSharing, contextAssistant: matrixSharing },
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
    // Four cards: experimental crawlers off; matrix sharing, custom reports and the context assistant on.
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
    expect(screen.getAllByText('Enabled')).toHaveLength(3);
  });

  it('shows the flag as Enabled when the feature is on', async () => {
    render(true);
    const toggle = await screen.findByRole('switch', { name: 'Experimental crawlers' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getAllByText('Enabled')).toHaveLength(1);
    expect(screen.getAllByText('Disabled')).toHaveLength(3);
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

  describe('Matrix sharing (#1166)', () => {
    it('reads its own flag, not the crawler one', async () => {
      render(true, undefined, false);
      const sharing = await screen.findByRole('switch', { name: 'Matrix sharing' });
      const crawlers = screen.getByRole('switch', { name: 'Experimental crawlers' });
      await waitFor(() => expect(sharing).toHaveAttribute('aria-checked', 'false'));
      expect(crawlers).toHaveAttribute('aria-checked', 'true');
    });

    it('turns sharing ON by posting matrixSharing:true, then reloads', async () => {
      const { authFetch } = render(true, undefined, false);
      await userEvent.click(await screen.findByRole('switch', { name: 'Matrix sharing' }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      const [, opts] = authFetch.mock.calls.find(([u]) => String(u).includes('/features/toggle'));
      expect(JSON.parse(opts.body)).toEqual({ feature: 'matrixSharing', enabled: true });
    });

    it('turns sharing OFF by posting matrixSharing:false', async () => {
      const { authFetch } = render(false, undefined, true);
      await userEvent.click(await screen.findByRole('switch', { name: 'Matrix sharing' }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
      const [, opts] = authFetch.mock.calls.find(([u]) => String(u).includes('/features/toggle'));
      expect(JSON.parse(opts.body)).toEqual({ feature: 'matrixSharing', enabled: false });
    });

    it('surfaces a failed toggle and does not reload', async () => {
      render(true, jsonResponse({ error: 'Sharing toggle failed' }, { ok: false, status: 500 }), false);
      await userEvent.click(await screen.findByRole('switch', { name: 'Matrix sharing' }));
      expect(await screen.findByText('Sharing toggle failed')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
    });

    it('tells the operator that switching off stops sent links but keeps the shares', async () => {
      render(false);
      expect(await screen.findByText(/stops existing share links from opening; the shares themselves are kept/i))
        .toBeInTheDocument();
    });

    it('cannot be flipped before the flags have loaded', async () => {
      renderWithProviders(h(ExperimentalFeaturesSection, { features: null, version: EDGE_VERSION }),
        { auth: { authFetch: makeAuthFetch({}) } });
      expect(await screen.findByRole('switch', { name: 'Matrix sharing' })).toBeDisabled();
    });
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
