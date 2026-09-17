// @vitest-environment jsdom
//
// The Reports page is a catalogue: it lists what the deployment registered and
// hands a report off to its own tab. It deliberately does NOT run a report — a
// test that finds report content here is finding a regression.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, within,
} from '@ui/test-utils/renderWithProviders';
import ReportsPage from '@ui/components/ReportsPage';

const ORPHANS = {
  name: 'orphaned-accounts', displayName: 'Orphaned Accounts',
  description: 'Accounts that are not linked to any identity.',
  form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'systemName', label: 'System' }],
  exportFormats: ['json', 'xml'],
};
const STALE = { ...ORPHANS, name: 'stale-accounts', displayName: 'Stale Accounts', description: 'Untouched for a year.' };

// A custom report as the API lists it. Author and editor differ on purpose, so a
// byline that shows only one of them is caught.
const GUESTS = {
  ...ORPHANS, name: 'custom-3f1c2a9e', displayName: 'Guests without a manager', description: 'Built for the audit.',
  source: 'custom', editable: { builderId: '3f1c2a9e' },
  author: { createdBy: 'ann@example.com', updatedBy: 'bob@example.com', updatedAt: '2026-09-16T08:30:00.000Z' },
};
const BUILTIN = { ...ORPHANS, source: 'builtin', author: null, editable: null };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function renderPage({ list = [ORPHANS], onOpenDetail = () => {}, features = {}, auth = {} } = {}) {
  const authFetch = makeAuthFetch((url) => {
    if (String(url).includes('/api/reports')) return typeof list === 'function' ? list() : { data: list, total: list.length };
    return undefined;
  });
  return renderWithProviders(<ReportsPage onOpenDetail={onOpenDetail} />, { auth: { authFetch, ...auth }, features });
}

/** The text of the report links inside one titled section of the page. */
const linksIn = (sectionName) => within(screen.getByRole('region', { name: sectionName }))
  .queryAllByRole('link').map(a => a.textContent);

describe('ReportsPage', () => {
  it('lists every registered report with its description', async () => {
    renderPage({ list: [ORPHANS, STALE] });

    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Orphaned Accounts/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Stale Accounts/ })).toBeInTheDocument();
    // Each description is its own paragraph under the report's name, not loose
    // text that replaced it.
    expect(screen.getByText(ORPHANS.description).tagName).toBe('P');
    expect(screen.getByText(STALE.description).tagName).toBe('P');
  });

  it('lists reports without running any of them', async () => {
    // The list is the whole page: no rows are fetched until a report is opened.
    const { authFetch } = renderPage({ list: [ORPHANS, STALE] });

    expect(await screen.findAllByRole('link')).toHaveLength(2);
    expect(authFetch.mock.calls.filter(([u]) => String(u).includes('/rows'))).toHaveLength(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens the report in its own tab, labelled with the report name', async () => {
    const onOpenDetail = vi.fn();
    renderPage({ onOpenDetail });
    const link = await screen.findByRole('link', { name: /Orphaned Accounts/ });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(onOpenDetail).toHaveBeenCalledWith('report', 'orphaned-accounts', 'Orphaned Accounts');
    // The in-app open replaces the hash navigation rather than racing it — two
    // routes to the same tab would open it twice, once unlabelled.
    expect(event.defaultPrevented).toBe(true);
  });

  it('is a real link to the report route, so it can be opened in a browser tab', async () => {
    // href, not just an onClick: middle-click and ctrl/cmd-click have to work.
    renderPage({ list: [{ ...ORPHANS, name: 'odd/name' }] });

    expect(await screen.findByRole('link', { name: /Orphaned Accounts/ }))
      .toHaveAttribute('href', '#report:odd%2Fname');
  });

  it('lets a modified click through to the browser instead of hijacking it', async () => {
    const onOpenDetail = vi.fn();
    renderPage({ onOpenDetail });
    const link = await screen.findByRole('link', { name: /Orphaned Accounts/ });

    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, modifier).toBe(false);
    }
    // A middle click (button 1) is the browser's own new-tab gesture too.
    const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);

    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('leaves the plain hash navigation alone when no tab opener was supplied', async () => {
    renderPage({ onOpenDetail: null });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    (await screen.findByRole('link', { name: /Orphaned Accounts/ })).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('says it is loading while the report list is in flight', async () => {
    renderPage({ list: () => new Promise(() => {}) });
    expect(await screen.findByText('Loading reports…')).toBeInTheDocument();
  });

  it('tells the user when the report list fails to load', async () => {
    renderPage({ list: () => jsonResponse({ error: 'nope' }, { ok: false, status: 503 }) });

    expect(await screen.findByText('Error loading reports')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  });

  it('shows an empty state when the deployment registers no reports', async () => {
    renderPage({ list: [] });

    expect(await screen.findByText('No reports available')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('treats a list response without a data array as no reports', async () => {
    renderPage({ list: () => ({}) });
    expect(await screen.findByText('No reports available')).toBeInTheDocument();
  });

  it('renders a report that declares no description', async () => {
    renderPage({ list: [{ ...ORPHANS, description: '' }] });

    expect(await screen.findByRole('link', { name: /Orphaned Accounts/ })).toBeInTheDocument();
    expect(screen.queryByText(ORPHANS.description)).not.toBeInTheDocument();
  });
});

describe('ReportsPage — standard and custom reports apart', () => {
  it('lists built-in and custom reports in separate sections, each report in exactly one', async () => {
    // The custom report is listed FIRST by the API, so a page that simply kept the
    // API order in one list would put it above the standard ones.
    renderPage({ list: [GUESTS, BUILTIN], features: { customReports: true } });
    await screen.findByRole('region', { name: 'Custom reports' });

    expect(linksIn('Standard reports')).toEqual([expect.stringContaining('Orphaned Accounts')]);
    expect(linksIn('Custom reports')).toEqual([expect.stringContaining('Guests without a manager')]);
  });

  it('treats a report that does not say where it came from as a standard one', async () => {
    // Templates registered before `source` existed must not drift into the custom list.
    renderPage({ list: [ORPHANS], features: { customReports: true } });
    await screen.findByRole('region', { name: 'Standard reports' });
    expect(linksIn('Standard reports')).toHaveLength(1);
    expect(linksIn('Custom reports')).toEqual([]);
  });

  it('says who built a custom report and who changed it last', async () => {
    renderPage({ list: [BUILTIN, GUESTS], features: { customReports: true } });
    const custom = await screen.findByRole('link', { name: /Guests without a manager/ });

    expect(custom).toHaveTextContent('By ann@example.com');
    expect(custom).toHaveTextContent('last edited by bob@example.com on');
    // A standard report has no author, and shows no invented one.
    expect(screen.getByRole('link', { name: /Orphaned Accounts/ })).not.toHaveTextContent(/By |last edited/);
  });

  it('does not name the author twice when they were also the last to edit', async () => {
    const own = { ...GUESTS, author: { ...GUESTS.author, updatedBy: 'ann@example.com' } };
    renderPage({ list: [own], features: { customReports: true } });
    const link = await screen.findByRole('link', { name: /Guests without a manager/ });

    expect(link.textContent.match(/ann@example\.com/g)).toHaveLength(1);
    expect(link).toHaveTextContent(/By ann@example\.com · last edited on /);
  });

  it('shows no byline for a custom report nobody was recorded against', async () => {
    const anonymous = { ...GUESTS, author: { createdBy: null, updatedBy: null, updatedAt: null } };
    renderPage({ list: [anonymous], features: { customReports: true } });
    const link = await screen.findByRole('link', { name: /Guests without a manager/ });
    expect(link).not.toHaveTextContent(/By |last edited/i);
  });

  it('offers New report in the custom section, and an empty custom section says what it is for', async () => {
    const onOpenDetail = vi.fn();
    renderPage({ list: [BUILTIN], features: { customReports: true }, onOpenDetail });
    const custom = await screen.findByRole('region', { name: 'Custom reports' });

    expect(within(custom).getByText(/No custom reports yet/)).toBeInTheDocument();
    within(custom).getByRole('button', { name: 'New report' }).click();
    expect(onOpenDetail).toHaveBeenCalledWith('report-builder', expect.stringMatching(/^new-\d+$/), 'New report');
    // Building belongs to the custom section, not to the standard one.
    expect(within(screen.getByRole('region', { name: 'Standard reports' })).queryByRole('button')).toBeNull();
  });

  it('lets a reader open custom reports but not change them', async () => {
    renderPage({ list: [BUILTIN, GUESTS], features: { customReports: true }, auth: READER });
    const custom = await screen.findByRole('region', { name: 'Custom reports' });

    expect(within(custom).getByRole('link', { name: /Guests without a manager/ })).toBeInTheDocument();
    expect(within(custom).queryByRole('button', { name: /New report|Edit|Delete/ })).toBeNull();
  });

  it('shows no custom section at all to a reader when there are no custom reports', async () => {
    // Also what an install without the feature looks like: the API lists none.
    renderPage({ list: [BUILTIN], features: { customReports: true }, auth: READER });
    await screen.findByRole('region', { name: 'Standard reports' });
    expect(screen.queryByRole('region', { name: 'Custom reports' })).toBeNull();
    expect(screen.queryByText(/No custom reports yet/)).toBeNull();
  });

  it('offers building from an empty catalogue, instead of saying there is nothing', async () => {
    renderPage({ list: [], features: { customReports: true } });
    expect(await screen.findByRole('button', { name: 'New report' })).toBeInTheDocument();
    expect(screen.queryByText('No reports available')).toBeNull();
  });
});
