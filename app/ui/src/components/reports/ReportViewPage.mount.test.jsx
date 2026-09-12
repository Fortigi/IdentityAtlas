// @vitest-environment jsdom
//
// A report in its own tab: it runs the report it was opened for, draws it from
// the metadata the API returned, refreshes against the latest data, and hands
// the file the server produced to the browser.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, blobResponse, screen, fireEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';
import ReportViewPage from '@ui/components/reports/ReportViewPage';

const META = {
  name: 'orphaned-accounts', displayName: 'Orphaned Accounts',
  description: 'Accounts that are not linked to any identity.',
  form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [{ key: 'displayName', label: 'Account' }, { key: 'systemName', label: 'System' }],
  exportFormats: ['csv', 'json'],
};

const ROW = { displayName: 'Ada Lovelace', systemName: 'Entra ID', _entity: { kind: 'user', id: 'p1' } };

const rowsBody = (rows, over = {}) => ({
  ...META, rows, total: rows.length, generatedAt: '2026-09-08T10:00:00.000Z', ...over,
});

// `rows` is a handler (or body) for the rows call; `download` for the export call.
function renderReport({
  rows = rowsBody([ROW]),
  download = blobResponse('"Account"\r\n"Ada Lovelace"', { type: 'text/csv', filename: 'identity-atlas-report.csv' }),
  reportName = 'orphaned-accounts',
  ...props
} = {}) {
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes('/export')) return typeof download === 'function' ? download(s) : download;
    if (s.includes('/rows')) return typeof rows === 'function' ? rows(s) : rows;
    return undefined;
  });
  return renderWithProviders(
    <ReportViewPage reportName={reportName} onOpenDetail={() => {}} {...props} />,
    { auth: { authFetch } },
  );
}

describe('ReportViewPage', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs the report it was opened for and renders it from the API metadata', async () => {
    const { authFetch } = renderReport();

    expect(await screen.findByRole('heading', { name: 'Orphaned Accounts' })).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/reports/orphaned-accounts/rows');
    expect(screen.getByRole('columnheader', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Entra ID' })).toBeInTheDocument();
    expect(screen.getByText(META.description).tagName).toBe('P');
    // \b so the singular assertion can't be satisfied by "1 rows".
    expect(screen.getByText(/^1 row\b/)).toBeInTheDocument();
    expect(screen.getByText(/generated/)).toBeInTheDocument();
  });

  it('encodes the report name it fetches', async () => {
    const { authFetch } = renderReport({ reportName: 'odd/name' });

    await screen.findByRole('heading', { name: 'Orphaned Accounts' });
    expect(authFetch).toHaveBeenCalledWith('/api/reports/odd%2Fname/rows');
  });

  it('pluralises the row count', async () => {
    renderReport({ rows: rowsBody([ROW, { ...ROW, displayName: 'Grace Hopper', _entity: { kind: 'user', id: 'p2' } }]) });
    expect(await screen.findByText(/^2 rows\b/)).toBeInTheDocument();
  });

  it('says it is running the report before the first rows arrive', async () => {
    renderReport({ rows: () => new Promise(() => {}) });

    expect(await screen.findByText('Running report…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the previous rows on screen while a refresh is in flight', async () => {
    let pending;
    let call = 0;
    renderReport({ rows: () => (call++ === 0 ? rowsBody([ROW]) : new Promise((r) => { pending = r; })) });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.queryByText('Running report…')).not.toBeInTheDocument();

    pending(rowsBody([]));
    expect(await screen.findByText('No rows')).toBeInTheDocument();
  });

  it('re-runs the report when Refresh is clicked, picking up the newer data', async () => {
    let call = 0;
    const { authFetch } = renderReport({ rows: () => (call++ === 0 ? rowsBody([ROW]) : rowsBody([])) });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('No rows')).toBeInTheDocument();
    expect(authFetch.mock.calls.filter(([u]) => String(u).includes('/rows'))).toHaveLength(2);
  });

  it('disables Refresh while a re-run is in flight', async () => {
    let resolveRows;
    let call = 0;
    renderReport({
      rows: () => (call++ === 0
        ? rowsBody([ROW])
        : new Promise((resolve) => { resolveRows = () => resolve(rowsBody([ROW])); })),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();

    resolveRows();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('offers one download button per format the API advertised, and no more', async () => {
    renderReport();

    expect(await screen.findByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download XLSX/ })).not.toBeInTheDocument();
  });

  it.each([
    ['advertises an empty list', []],
    ['is too old to advertise any', undefined],
  ])('offers no download at all when the API %s', async (_label, exportFormats) => {
    renderReport({ rows: rowsBody([ROW], { exportFormats }) });

    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('downloads the report from the export endpoint in the format that was clicked', async () => {
    const { authFetch } = renderReport();

    fireEvent.click(await screen.findByRole('button', { name: 'Download JSON' }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      '/api/reports/orphaned-accounts/export?format=json'));
    // The rows the table shows are not re-serialised locally — the file is the
    // server's own export response.
    await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled());
  });

  it('shows the download as busy while it is being prepared, then goes back', async () => {
    let finish;
    renderReport({
      download: () => new Promise((resolve) => {
        finish = () => resolve(blobResponse('csv', { type: 'text/csv', filename: 'x.csv' }));
      }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));

    expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled();
    // The other format is locked out too — one download at a time.
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeDisabled();

    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled());
  });

  it('tells the user when the download fails, and keeps the report on screen', async () => {
    renderReport({ download: () => blobResponse('{}', { ok: false, status: 500 }) });

    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));

    expect(await screen.findByText('Download failed')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  });

  it('clears a previous download error when the next download is started', async () => {
    let call = 0;
    renderReport({
      download: () => (call++ === 0
        ? blobResponse('{}', { ok: false, status: 500 })
        : blobResponse('csv', { type: 'text/csv', filename: 'x.csv' })),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Download failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(screen.queryByText('Download failed')).not.toBeInTheDocument());
  });

  it('opens the entity detail tab from a report row', async () => {
    const onOpenDetail = vi.fn();
    renderReport({ onOpenDetail });

    fireEvent.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p1', 'Ada Lovelace');
  });

  it('relabels its tab once the report says what it is called', async () => {
    // A tab opened from a URL starts out labelled with the slug.
    const onCacheData = vi.fn();
    renderReport({ onCacheData });

    await waitFor(() => expect(onCacheData).toHaveBeenCalledWith(
      'orphaned-accounts', 'report', { displayName: 'Orphaned Accounts' }));
  });

  it('leaves the tab label alone when the report names no display name', async () => {
    // Relabelling with an empty name would blank the tab the user opened.
    const onCacheData = vi.fn();
    renderReport({ rows: rowsBody([ROW], { displayName: '' }), onCacheData });

    expect(await screen.findByRole('cell', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(onCacheData).not.toHaveBeenCalled();
  });

  it('shows the empty state — not an error — when the report finds nothing', async () => {
    renderReport({ rows: rowsBody([]) });

    expect(await screen.findByText('No rows')).toBeInTheDocument();
    expect(screen.getByText(/^0 rows\b/)).toBeInTheDocument();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();
  });

  it('explains rather than crashes when the report declares a form this UI cannot draw', async () => {
    renderReport({ rows: rowsBody([ROW], { form: 'sankey' }) });

    expect(await screen.findByText('Unsupported report form')).toBeInTheDocument();
    expect(screen.getByText(/"sankey"/)).toBeInTheDocument();
  });

  it('tells the user when the report fails to run, with a way back out of the tab', async () => {
    const onClose = vi.fn();
    renderReport({ rows: jsonResponse({ error: 'Failed to run report' }, { ok: false, status: 500 }), onClose });

    expect(await screen.findByText('Error running report')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reports an unknown report name as an error instead of an endless spinner', async () => {
    renderReport({ rows: jsonResponse({ error: 'Report not found' }, { ok: false, status: 404 }) });

    expect(await screen.findByText('Error running report')).toBeInTheDocument();
    expect(screen.getByText('HTTP 404')).toBeInTheDocument();
  });

  it('renders a report that declares no description', async () => {
    renderReport({ rows: rowsBody([ROW], { description: '' }) });

    expect(await screen.findByRole('heading', { name: 'Orphaned Accounts' })).toBeInTheDocument();
    expect(screen.queryByText(META.description)).not.toBeInTheDocument();
  });

  it('omits the generation time when the response carries none', async () => {
    renderReport({ rows: rowsBody([ROW], { generatedAt: null }) });

    expect(await screen.findByText(/^1 row\b/)).toBeInTheDocument();
    expect(screen.queryByText(/generated/)).not.toBeInTheDocument();
  });
});
