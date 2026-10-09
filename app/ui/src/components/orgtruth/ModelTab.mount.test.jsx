// @vitest-environment jsdom
//
// Organisation → Model against a stubbed GET /model: nodes and edges drawn from
// it, the table view sorted by count, the filters reaching the URL, the Mermaid
// copy, the dark palette, the empty model and the 501 path.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/utils/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { copyText } = await import('@ui/utils/clipboard');
const { default: ModelTab } = await import('./ModelTab');

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };

const MODEL = {
  entityTypes: [
    { type: 'Project', count: 87, proposed: 0, attributeKeys: ['budget', 'costCenter'], sources: 2, lastObservedAt: '2026-10-01T09:00:00Z' },
    { type: 'Person', count: 60, proposed: 4, attributeKeys: [], sources: 1 },
  ],
  predicates: [
    { predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85 },
    { predicate: 'sponsor', fromType: 'Project', toType: 'Person', count: 90 },
  ],
  links: [{ entityType: 'Person', targetType: 'Principal', accepted: 51, proposed: 9 }],
  systemTypes: [{ targetType: 'Principal', count: 1127 }],
  totals: { entities: 147, relations: 175, links: 60, sources: 2 },
};

function render({ routes = {}, theme, auth = IMPORTER } = {}) {
  const authFetch = makeAuthFetch({
    '/api/org-truth/model': MODEL,
    '/api/org-truth/sources': [{ id: 's1', displayName: 'Contoso projects' }],
    ...routes,
  });
  const onImport = vi.fn();
  const r = renderWithProviders(<ModelTab onImport={onImport} />,
    { auth: { authFetch, ...auth }, features: { orgTruth: true }, ...(theme ? { theme } : {}) });
  return { authFetch, onImport, ...r };
}

describe('ModelTab', () => {
  it('draws one node per type and one edge per predicate and link', async () => {
    const { container } = render();
    await screen.findByRole('img', { name: 'Organisation model diagram' });
    const nodes = [...container.querySelectorAll('[data-node]')].map(n => n.getAttribute('data-node'));
    expect(nodes).toEqual(['t:Project', 't:Person', 's:Principal']);
    const edges = [...container.querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge'));
    expect(edges).toEqual(['p:Project:owner:Person', 'p:Project:sponsor:Person', 'l:Person:Principal']);
    expect(container.querySelector('[data-edge="l:Person:Principal"]')).toHaveAttribute('stroke-dasharray', '5 4');
    expect(screen.getByText('51 accepted · 9 proposed')).toBeInTheDocument();
    expect(screen.getByText('owner 85')).toBeInTheDocument();
    expect(screen.getByTestId('model-totals')).toHaveTextContent('147 entities · 175 relations · 60 links · 2 sources');
  });

  it('puts the attribute keys and sources in the node tooltip', async () => {
    const { container } = render();
    await screen.findByRole('img', { name: 'Organisation model diagram' });
    expect(container.querySelector('[data-node="t:Project"] title').textContent)
      .toBe('Project: 87 entities (0 proposed)\nAttributes: budget, costCenter\nSources: 2');
    expect(container.querySelector('[data-node="t:Person"] title').textContent).toContain('Attributes: none');
    expect(container.querySelector('[data-node="s:Principal"] title').textContent).toBe('Principal: 1127 in the system truth');
  });

  it('uses the dark palette in dark mode', async () => {
    const { container } = render({ theme: { isDark: true, mode: 'dark' } });
    await screen.findByRole('img', { name: 'Organisation model diagram' });
    expect(container.querySelector('[data-node="t:Project"] rect')).toHaveAttribute('fill', '#3730a3');
  });

  it('shows the same data as tables, sortable by count', async () => {
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Table' }));
    const types = within(screen.getByRole('table', { name: 'Entity types' }));
    const typeNames = () => types.getAllByRole('row').slice(1).map(r => r.cells[0].textContent);
    expect(typeNames()).toEqual(['Project', 'Person']);
    expect(types.getByText('budget, costCenter')).toBeInTheDocument();
    await userEvent.click(types.getByRole('button', { name: /Count/ }));
    expect(typeNames()).toEqual(['Person', 'Project']);

    const preds = within(screen.getByRole('table', { name: 'Predicates' }));
    const predNames = () => preds.getAllByRole('row').slice(1).map(r => r.cells[0].textContent);
    expect(predNames()).toEqual(['sponsor', 'owner']);
    await userEvent.click(preds.getByRole('button', { name: /Count/ }));
    expect(predNames()).toEqual(['owner', 'sponsor']);

    await userEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    expect(screen.getByRole('img', { name: 'Organisation model diagram' })).toBeInTheDocument();
  });

  it('sends the source and include-closed filters to the API', async () => {
    const { authFetch } = render();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Source' }), 's1');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include closed' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/model?sourceId=s1&includeClosed=1'));
  });

  it('copies the model as Mermaid text', async () => {
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy as Mermaid' }));
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('t_Project -->|"owner 85"| t_Person'));
  });

  it('shows an empty model with the import action', async () => {
    const { onImport } = render({ routes: { '/api/org-truth/model': { entityTypes: [] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Import organisation truth' }));
    expect(onImport).toHaveBeenCalled();
    expect(screen.getByText('No model yet')).toBeInTheDocument();
  });

  it('hides the source filter when the sources cannot be read, and says 501 is not available yet', async () => {
    render({ routes: {
      '/api/org-truth/model': jsonResponse({}, { ok: false, status: 501 }),
      '/api/org-truth/sources': jsonResponse({}, { ok: false, status: 501 }),
    } });
    expect(await screen.findByText('Model — not available yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
  });
});
