// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';
import ReportsPage from '@ui/components/ReportsPage';

const ORPHANS = {
  name: 'orphaned-accounts', displayName: 'Orphaned Accounts',
  description: 'Accounts that are not linked to any identity.',
  form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'systemName', label: 'System' }],
};

const rowsBody = (rows, over = {}) => ({
  ...ORPHANS, rows, total: rows.length, generatedAt: '2026-09-08T10:00:00.000Z', ...over,
});

const ROW = { displayName: 'Ada Lovelace', systemName: 'Entra ID', _entity: { kind: 'user', id: 'p1' } };

// `list` is the report-list response, `rows` a handler (or body) for the rows call.
function renderPage({ list = [ORPHANS], rows = rowsBody([ROW]), onOpenDetail = () => {} } = {}) {
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes('/rows')) return typeof rows === 'function' ? rows(s) : rows;
    if (s.includes('/api/reports')) return typeof list === 'function' ? list() : { data: list, total: list.length };
    return undefined;
  });
  return renderWithProviders(<ReportsPage onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
}

describe('ReportsPage', () => {
  it('runs the first report and renders it from the metadata the API returned', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Entra ID' })).toBeInTheDocument();
    // The description is its own paragraph under the report heading.
    expect(screen.getByText(ORPHANS.description).tagName).toBe('P');
    // \b so the singular assertion can't be satisfied by "1 rows".
    expect(screen.getByText(/^1 row\b/)).toBeInTheDocument();
    expect(screen.getByText(/generated/)).toBeInTheDocument();
  });

  it('pluralises the row count', async () => {
    renderPage({ rows: rowsBody([ROW, { ...ROW, displayName: 'Grace Hopper', _entity: { kind: 'user', id: 'p2' } }]) });
    expect(await screen.findByText(/^2 rows\b/)).toBeInTheDocument();
  });

  it('says it is loading while the report list is still in flight', async () => {
    renderPage({ list: () => new Promise(() => {}) });
    expect(await screen.findByText('Loading reports…')).toBeInTheDocument();
  });

  it('says it is running the report before the first rows arrive', async () => {
    renderPage({ rows: () => new Promise(() => {}) });

    expect(await screen.findByText('Running report…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the previous rows on screen while a refresh is in flight', async () => {
    // The old content must not be swapped for a spinner mid-refresh — the
    // "running" state is for the FIRST run only.
    let pending;
    let call = 0;
    renderPage({ rows: () => (call++ === 0 ? rowsBody([ROW]) : new Promise((r) => { pending = r; })) });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.queryByText('Running report…')).not.toBeInTheDocument();

    pending(rowsBody([]));
    expect(await screen.findByText('No rows')).toBeInTheDocument();
  });

  it('re-fetches the report when Refresh is clicked, picking up the newer data', async () => {
    let call = 0;
    const { authFetch } = renderPage({ rows: () => (call++ === 0 ? rowsBody([ROW]) : rowsBody([])) });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('No rows')).toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([u]) => String(u).includes('/rows'))).toHaveLength(2);
  });

  it('runs the report the user picks from the list', async () => {
    const OTHER = { ...ORPHANS, name: 'stale-accounts', displayName: 'Stale Accounts' };
    const { authFetch } = renderPage({
      list: [ORPHANS, OTHER],
      rows: (url) => rowsBody(url.includes('stale-accounts') ? [{ ...ROW, displayName: 'Old Account' }] : [ROW]),
    });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Stale Accounts' }));

    expect(await screen.findByRole('cell', { name: 'Old Account' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Stale Accounts' })).toHaveAttribute('aria-selected', 'true');
    // Exactly one tab is selected — the one that was picked.
    expect(screen.getByRole('tab', { name: 'Orphaned Accounts' })).toHaveAttribute('aria-selected', 'false');
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/reports/stale-accounts/rows'));
  });

  it('selects the first report until the user picks another', async () => {
    const OTHER = { ...ORPHANS, name: 'stale-accounts', displayName: 'Stale Accounts' };
    renderPage({ list: [ORPHANS, OTHER] });

    expect(await screen.findByRole('tab', { name: 'Orphaned Accounts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Stale Accounts' })).toHaveAttribute('aria-selected', 'false');
  });

  it('opens the account detail tab from a report row', async () => {
    const onOpenDetail = vi.fn();
    renderPage({ onOpenDetail });

    fireEvent.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p1', 'Ada Lovelace');
  });

  it('shows the empty state — not an error — when the report finds nothing', async () => {
    renderPage({ rows: rowsBody([]) });

    expect(await screen.findByText('No rows')).toBeInTheDocument();
    expect(screen.getByText(/^0 rows\b/)).toBeInTheDocument();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();
  });

  it('explains rather than crashes when the report declares a form this UI cannot draw', async () => {
    renderPage({ list: [{ ...ORPHANS, form: 'sankey' }], rows: rowsBody([ROW], { form: 'sankey' }) });

    expect(await screen.findByText('Unsupported report form')).toBeInTheDocument();
    expect(screen.getByText(/"sankey"/)).toBeInTheDocument();
  });

  it('tells the user when a report fails to run, without dropping the page', async () => {
    renderPage({ rows: jsonResponse({ error: 'Failed to run report' }, { ok: false, status: 500 }) });

    expect(await screen.findByText('Error running Orphaned Accounts')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Orphaned Accounts' })).toBeInTheDocument();
  });

  it('tells the user when the report list itself fails to load', async () => {
    renderPage({ list: () => jsonResponse({ error: 'nope' }, { ok: false, status: 503 }) });

    expect(await screen.findByText('Error loading reports')).toBeInTheDocument();
  });

  it('shows an empty state when the deployment registers no reports', async () => {
    renderPage({ list: [] });

    expect(await screen.findByText('No reports available')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('treats a list response without a data array as no reports', async () => {
    renderPage({ list: () => ({}) });
    expect(await screen.findByText('No reports available')).toBeInTheDocument();
  });

  it('disables Refresh while the report is running', async () => {
    let resolveRows;
    renderPage({ rows: () => new Promise((resolve) => { resolveRows = () => resolve(rowsBody([ROW])); }) });

    const refresh = await screen.findByRole('button', { name: 'Refreshing…' });
    expect(refresh).toBeDisabled();

    resolveRows();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });
});
