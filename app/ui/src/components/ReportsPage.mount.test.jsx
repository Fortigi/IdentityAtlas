// @vitest-environment jsdom
//
// The Reports page is a catalogue: it lists what the deployment registered and
// hands a report off to its own tab. It deliberately does NOT run a report — a
// test that finds report content here is finding a regression.

import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent,
} from '@ui/test-utils/renderWithProviders';
import ReportsPage from '@ui/components/ReportsPage';

const ORPHANS = {
  name: 'orphaned-accounts', displayName: 'Orphaned Accounts',
  description: 'Accounts that are not linked to any identity.',
  form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'systemName', label: 'System' }],
  exportFormats: ['csv', 'json'],
};
const STALE = { ...ORPHANS, name: 'stale-accounts', displayName: 'Stale Accounts', description: 'Untouched for a year.' };

function renderPage({ list = [ORPHANS], onOpenDetail = () => {} } = {}) {
  const authFetch = makeAuthFetch((url) => {
    if (String(url).includes('/api/reports')) return typeof list === 'function' ? list() : { data: list, total: list.length };
    return undefined;
  });
  return renderWithProviders(<ReportsPage onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
}

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
