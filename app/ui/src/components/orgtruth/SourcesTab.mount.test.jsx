// @vitest-environment jsdom
//
// Organisation → Sources against stubbed routes: the table, the runs under a
// source, Download, "Import again" only for an importer, the empty state, and
// the 501 "not available yet" path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, blobResponse, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/utils/download', async (orig) => ({ ...(await orig()), triggerDownload: vi.fn() }));
const { triggerDownload } = await import('@ui/utils/download');
const { default: SourcesTab } = await import('./SourcesTab');

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const SOURCES = [
  { id: 's1', displayName: 'Contoso projects', fileName: 'projects.xlsx', kind: 'list', observedAt: '2026-10-01T09:00:00Z', uploadedBy: 'analyst@contoso.com', byteSize: 2048, runCount: 2 },
  { id: 's2', displayName: 'Northwind assets', fileName: 'Northwind assets', kind: 'list', observedAt: '2026-09-01T09:00:00Z', uploadedBy: null, byteSize: null },
];
const RUNS = [
  { id: 'r1', sourceId: 's1', profileId: 'p1', mode: 'full', status: 'completed', createdAt: '2026-10-01T10:00:00Z', startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z',
    stats: { entities: { byType: { Project: 87, Person: 61 } }, relations: { byPredicate: { owner: 85 } }, links: { linked: 51, proposed: 9 } } },
  { id: 'r2', sourceId: 's1', profileId: 'p2', mode: 'delta', status: 'failed', createdAt: '2026-10-02T10:00:00Z', error: 'Column ProjectCode is missing' },
];

function render({ auth = IMPORTER, routes = {}, onDelete, ...props } = {}) {
  const table = {
    '/download': blobResponse('bytes', { filename: 'projects.xlsx' }),
    '/api/org-truth/sources': SOURCES,
    '/api/org-truth/runs': RUNS,
    ...routes,
  };
  // A DELETE is answered by `onDelete` when given; everything else by the table.
  const authFetch = makeAuthFetch((url, opts) => {
    if (opts?.method === 'DELETE' && onDelete) return onDelete(url);
    const key = Object.keys(table).find(k => String(url).includes(k));
    return key ? table[key] : undefined;
  });
  const onImport = vi.fn();
  const onImportAgain = vi.fn();
  renderWithProviders(<SourcesTab onImport={onImport} onImportAgain={onImportAgain} {...props} />,
    { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onImport, onImportAgain };
}

const rowOf = async (name) => (await screen.findByRole('button', { name })).closest('tr');

beforeEach(() => triggerDownload.mockClear());

describe('SourcesTab', () => {
  it('lists the sources with size, uploader and the latest run status', async () => {
    render();
    const row = within(await rowOf('Contoso projects'));
    expect(row.getByText('projects.xlsx')).toBeInTheDocument();
    expect(row.getByText('analyst@contoso.com')).toBeInTheDocument();
    expect(row.getByText('2.0 KB')).toBeInTheDocument();
    expect(row.getByText('2')).toBeInTheDocument();
    expect(row.getByText('failed')).toBeInTheDocument();
    const other = within(await rowOf('Northwind assets'));
    // A file name equal to the display name is not repeated; unknowns are dashes.
    expect(other.getAllByText('Northwind assets')).toHaveLength(1);
    expect(other.getAllByText('—')).toHaveLength(2);
    expect(other.getByText('0')).toBeInTheDocument();
  });

  it('expands a source into its runs with a stats summary, and collapses again', async () => {
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Contoso projects' }));
    expect(screen.getByText('148 entities · 85 relations · 51 linked · 9 proposed')).toBeInTheDocument();
    expect(screen.getByText('Column ProjectCode is missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contoso projects' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Northwind assets' }));
    expect(screen.queryByText('Column ProjectCode is missing')).toBeNull();
    expect(screen.getByText('No runs yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Northwind assets' }));
    expect(screen.queryByText('No runs yet.')).toBeNull();
  });

  it('downloads the original bytes', async () => {
    const { authFetch } = render();
    await userEvent.click(within(await rowOf('Contoso projects')).getByRole('button', { name: 'Download' }));
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/sources/s1/download');
    expect(triggerDownload).toHaveBeenCalledWith('projects.xlsx', expect.any(Blob));
  });

  it('offers Import again with the newest run profile, only to an importer', async () => {
    const { onImportAgain } = render();
    const row = within(await rowOf('Contoso projects'));
    await userEvent.click(row.getByRole('button', { name: 'Import again' }));
    expect(onImportAgain).toHaveBeenCalledWith('p2');
    // No run, no profile: nothing to import again.
    expect(within(await rowOf('Northwind assets')).queryByRole('button', { name: 'Import again' })).toBeNull();
  });

  it('hides Import again and Delete from a reader', async () => {
    render({ auth: READER });
    const row = within(await rowOf('Contoso projects'));
    expect(row.queryByRole('button', { name: 'Import again' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Delete Contoso projects' })).toBeNull();
  });

  it('deletes a source after the analyst confirms, then reloads the list', async () => {
    const { authFetch } = render({ onDelete: () => ({ deleted: 's1', displayName: 'Contoso projects' }) });
    await userEvent.click(within(await rowOf('Contoso projects')).getByRole('button', { name: 'Delete Contoso projects' }));
    expect(await screen.findByText(/^Delete "Contoso projects"\? Everything read from it/)).toBeInTheDocument();
    const listLoads = () => authFetch.mock.calls.filter(c => c[0] === '/api/org-truth/sources').length;
    const before = listLoads();
    // The confirmation's own button is named just "Delete"; the row's is "Delete Contoso projects".
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/sources/s1', { method: 'DELETE' });
    expect(await screen.findByText('"Contoso projects" deleted')).toBeInTheDocument();
    expect(listLoads()).toBe(before + 1);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const { authFetch } = render({ onDelete: () => ({}) });
    await userEvent.click(within(await rowOf('Contoso projects')).getByRole('button', { name: 'Delete Contoso projects' }));
    await screen.findByText('Please confirm');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Please confirm')).toBeNull();
    expect(authFetch.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false);
  });

  it('shows the server\'s reason when the delete is refused (an import still running)', async () => {
    render({ onDelete: () => jsonResponse({ error: 'An import of this source is still running; wait for it to finish.' }, { ok: false, status: 409 }) });
    await userEvent.click(within(await rowOf('Contoso projects')).getByRole('button', { name: 'Delete Contoso projects' }));
    await screen.findByText('Please confirm');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('An import of this source is still running; wait for it to finish.')).toBeInTheDocument();
  });

  it('still lists the sources when the runs fail', async () => {
    render({ routes: { '/api/org-truth/runs': jsonResponse({}, { ok: false, status: 500 }) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Contoso projects' }));
    expect(screen.getByText('The runs are not available.')).toBeInTheDocument();
  });

  it('offers the import button above the list to an importer, not to a reader', async () => {
    const { onImport } = render();
    await rowOf('Contoso projects');
    await userEvent.click(screen.getByRole('button', { name: 'Import organisation truth' }));
    expect(onImport).toHaveBeenCalledTimes(1);
    render({ auth: READER });
    await screen.findAllByRole('button', { name: 'Contoso projects' });
    expect(screen.getAllByRole('button', { name: 'Import organisation truth' })).toHaveLength(1); // only the first render's
  });

  it('shows the empty state with the import action for an importer', async () => {
    const { onImport } = render({ routes: { '/api/org-truth/sources': { data: [] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Import organisation truth' }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state without an action for a reader', async () => {
    render({ auth: READER, routes: { '/api/org-truth/sources': [] } });
    expect(await screen.findByText('No organisation sources yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import organisation truth' })).toBeNull();
  });

  it('renders a 501 as "not available yet"', async () => {
    render({ routes: { '/api/org-truth/sources': jsonResponse({}, { ok: false, status: 501 }) } });
    expect(await screen.findByText('Sources — not available yet')).toBeInTheDocument();
  });

  it('renders another failure as an error', async () => {
    render({ routes: { '/api/org-truth/sources': jsonResponse({}, { ok: false, status: 500 }) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sources: HTTP 500');
  });
});
