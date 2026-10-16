// @vitest-environment jsdom
//
// Organisation → Entities against stubbed routes: rows, opening a detail tab,
// filters and the debounced search reaching the URL, paging, the two empty
// states, and the 501 path.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import EntitiesTab from './EntitiesTab';

const ENTITIES = {
  data: [
    { id: 'e1', entityType: 'Project', displayName: 'Northwind Portal', status: 'accepted', observedAt: '2026-10-01T09:00:00Z', validTo: null, sourceName: 'Contoso projects', linkCount: 3, relationCount: 2 },
    { id: 'e2', entityType: 'Person', displayName: 'Alice Contoso', status: 'proposed', observedAt: '2026-10-01T09:00:00Z', validTo: '2026-10-05T00:00:00Z', sourceName: null },
  ],
  total: 120, page: 1, pageSize: 50,
};

function render(entities = ENTITIES) {
  const authFetch = makeAuthFetch((url) => {
    if (url.startsWith('/api/org-truth/model')) return { entityTypes: [{ type: 'Project', count: 87 }, { type: 'Person', count: 60 }] };
    if (url.startsWith('/api/org-truth/entities')) return typeof entities === 'function' ? entities(url) : entities;
    return undefined;
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<EntitiesTab onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
  return { authFetch, onOpenDetail };
}

const entityCalls = (authFetch) => authFetch.mock.calls.map(c => c[0]).filter(u => u.startsWith('/api/org-truth/entities'));

describe('EntitiesTab', () => {
  it('lists entities with their type, status, counts and a closed pill', async () => {
    render();
    const row = within((await screen.findByRole('button', { name: 'Northwind Portal' })).closest('tr'));
    expect(row.getByText('Project')).toBeInTheDocument();
    expect(row.getByText('accepted')).toBeInTheDocument();
    expect(row.getByText('3')).toBeInTheDocument();
    expect(row.getByText('Contoso projects')).toBeInTheDocument();
    const closed = within(screen.getByRole('button', { name: 'Alice Contoso' }).closest('tr'));
    expect(closed.getByText('closed')).toBeInTheDocument();
    expect(closed.getAllByText('0')).toHaveLength(2);
    expect(closed.getByText('—')).toBeInTheDocument();
  });

  it('opens the entity detail tab from its name', async () => {
    const { onOpenDetail } = render();
    await userEvent.click(await screen.findByRole('button', { name: 'Alice Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'e2', 'Alice Contoso');
  });

  it('sends type, status and a debounced search, back on page 1', async () => {
    const { authFetch } = render();
    await screen.findByRole('button', { name: 'Northwind Portal' });
    expect(entityCalls(authFetch)[0]).toBe('/api/org-truth/entities?page=1&pageSize=50');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(entityCalls(authFetch)).toContain('/api/org-truth/entities?page=2&pageSize=50'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Person');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'proposed');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include closed' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search entities by name' }), 'ali');
    await waitFor(() => expect(entityCalls(authFetch)).toContain('/api/org-truth/entities?type=Person&status=proposed&q=ali&includeClosed=1&page=1&pageSize=50'));
    // Debounced: no request for the partial "a" or "al".
    expect(entityCalls(authFetch).filter(u => u.includes('q=a&') || u.includes('q=al&'))).toEqual([]);
  });

  it('tells "nothing imported yet" apart from "no match"', async () => {
    render((url) => ({ data: [], total: 0, url }));
    expect(await screen.findByText('Nothing imported yet')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'rejected');
    expect(await screen.findByText('No entity matches')).toBeInTheDocument();
  });

  it('renders a 501 as not available yet, keeping the filters', async () => {
    render(jsonResponse({}, { ok: false, status: 501 }));
    expect(await screen.findByText('Entities — not available yet')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
  });
});
