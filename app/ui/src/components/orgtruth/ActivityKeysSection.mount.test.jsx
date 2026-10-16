// @vitest-environment jsdom
//
// Review → Activity references against stubbed routes: one row per distinct
// value with role, raw value, rows and candidate; Accept / Reject / Pick
// another sending the exact PUT /activity-keys/:id body and reloading; the
// filters in the query; read-only for readers; nothing on a server without
// the route.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import ActivityKeysSection from './ActivityKeysSection';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const ANN = {
  id: 'k1', profileName: 'Hours', role: 'actor', rawValue: 'Ann Example', rows: 42, status: 'proposed',
  targetType: 'Identity', targetId: 'i1', targetLabel: 'Ann Example (HR)', confidence: 72,
  candidates: [
    { targetType: 'Identity', targetId: 'i1', label: 'Ann Example (HR)', confidence: 72 },
    { targetType: 'Principal', targetId: 'u2', label: 'ann@contoso.example', confidence: 65 },
  ],
};
const CONTOSO = { id: 'k2', profileName: 'Hours', role: 'subject', rawValue: 'Contoso BV', rows: 1, status: 'unmatched', targetId: null, candidates: [] };

function render({ auth = IMPORTER, keys = { data: [ANN, CONTOSO], total: 2 }, put = { ok: true } } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (opts.method === 'PUT') return typeof put === 'function' ? put(url, opts) : put;
    if (url.startsWith('/api/org-truth/activity-keys')) return typeof keys === 'function' ? keys(url) : keys;
    return undefined;
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<ActivityKeysSection onOpenDetail={onOpenDetail} />, { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onOpenDetail };
}

const row = async (name) => within(await screen.findByRole('listitem', { name }));
const listCalls = (af) => af.mock.calls.filter(c => !c[1]?.method).map(c => c[0]);
const putCalls = (af) => af.mock.calls.filter(c => c[1]?.method === 'PUT');

describe('ActivityKeysSection', () => {
  it('lists each value with its role, rows and candidate, and opens the candidate', async () => {
    const { onOpenDetail } = render();
    const ann = await row('Who “Ann Example”');
    expect(ann.getByText('42 rows')).toBeInTheDocument();
    expect(ann.getByText('72%')).toBeInTheDocument();
    await userEvent.click(ann.getByRole('button', { name: 'Ann Example (HR)' }));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'i1', 'Ann Example (HR)');
    const contoso = await row('On what “Contoso BV”');
    expect(contoso.getByText('No candidate')).toBeInTheDocument();
    expect(contoso.getByText('1 row')).toBeInTheDocument();
    expect(contoso.queryByRole('button', { name: /^Accept/ })).toBeNull();
    expect(contoso.getByRole('button', { name: 'Reject “Contoso BV”' })).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('accepts the current candidate with its target, toasts and reloads', async () => {
    const { authFetch } = render();
    const ann = await row('Who “Ann Example”');
    const before = listCalls(authFetch).length;
    await userEvent.click(ann.getByRole('button', { name: 'Accept Ann Example (HR) for “Ann Example”' }));
    await waitFor(() => expect(putCalls(authFetch)).toHaveLength(1));
    const [url, opts] = putCalls(authFetch)[0];
    expect(url).toBe('/api/org-truth/activity-keys/k1');
    expect(JSON.parse(opts.body)).toEqual({ status: 'accepted', targetType: 'Identity', targetId: 'i1' });
    expect(await screen.findByText('“Ann Example” is Ann Example (HR)')).toBeInTheDocument();
    await waitFor(() => expect(listCalls(authFetch).length).toBe(before + 1));
  });

  it('accepts another candidate picked from the list', async () => {
    const { authFetch } = render();
    const ann = await row('Who “Ann Example”');
    await userEvent.selectOptions(ann.getByRole('combobox', { name: 'Pick another candidate for “Ann Example”' }), 'u2');
    await waitFor(() => expect(putCalls(authFetch)).toHaveLength(1));
    expect(JSON.parse(putCalls(authFetch)[0][1].body)).toEqual({ status: 'accepted', targetType: 'Principal', targetId: 'u2' });
  });

  it('rejects with a body that names no target', async () => {
    const { authFetch } = render();
    await userEvent.click((await row('On what “Contoso BV”')).getByRole('button', { name: 'Reject “Contoso BV”' }));
    await waitFor(() => expect(putCalls(authFetch)).toHaveLength(1));
    expect(putCalls(authFetch)[0][0]).toBe('/api/org-truth/activity-keys/k2');
    expect(JSON.parse(putCalls(authFetch)[0][1].body)).toEqual({ status: 'rejected' });
  });

  it('shows a failed decision inline', async () => {
    render({ put: () => jsonResponse({ error: 'target gone' }, { ok: false, status: 409 }) });
    await userEvent.click((await row('On what “Contoso BV”')).getByRole('button', { name: 'Reject “Contoso BV”' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The decision was not saved: target gone');
  });

  it('sends the status and role filters, starting on proposed', async () => {
    const { authFetch } = render();
    await row('Who “Ann Example”');
    expect(listCalls(authFetch)[0]).toBe('/api/org-truth/activity-keys?status=proposed&page=1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'subject');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'unmatched');
    await waitFor(() => expect(listCalls(authFetch)).toContain('/api/org-truth/activity-keys?status=unmatched&role=subject&page=1'));
  });

  it('shows a reader the values without controls', async () => {
    render({ auth: READER });
    const ann = await row('Who “Ann Example”');
    expect(ann.queryByRole('button', { name: /Accept|Reject/ })).toBeNull();
    expect(ann.queryByRole('combobox')).toBeNull();
  });

  it('renders nothing on a server without the route', async () => {
    for (const status of [404, 501]) {
      const { authFetch } = render({ keys: () => jsonResponse({}, { ok: false, status }) });
      await waitFor(() => expect(authFetch).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByText('Activity references')).toBeNull());
    }
  });
});
