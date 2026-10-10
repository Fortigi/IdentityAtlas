// @vitest-environment jsdom
//
// Organisation → Model against a stubbed GET /model: the model canvas is the whole
// tab (no overview diagram, table or per-source filter above it), the totals line,
// include-closed reaching the URL, the Mermaid copy, the empty model and the 501 path.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor } from '@ui/test-utils/renderWithProviders';

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
  links: [
    { entityType: 'Person', targetType: 'Principal', via: 'displayName', accepted: 51, proposed: 9 },
    { entityType: 'Person', targetType: 'Principal', via: 'email', accepted: 3, proposed: 0 },
  ],
  entityLinks: [{ fromType: 'Person', toType: 'Project', via: 'team', accepted: 7, proposed: 1 }],
  profiles: [{
    id: 'p1', name: 'Contoso projects', version: 2, lastRunStatus: 'completed',
    recipe: { version: 1, entities: [{ type: 'Project', nameColumn: 'Name', attributes: [] }] }, linkRules: [],
  }],
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
  it('shows the model canvas and the totals, without an overview diagram, table or source filter', async () => {
    render();
    await screen.findByRole('group', { name: 'Model canvas' });
    expect(screen.getByTestId('model-totals')).toHaveTextContent('147 entities · 175 relations · 60 links · 2 sources');
    expect(screen.queryByRole('img', { name: 'Organisation model diagram' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Table' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
  });

  it('shows the model canvas under the overview and reloads the model after a rename', async () => {
    const { authFetch } = render({ routes: { '/rename-type': { profile: { id: 'p2' }, renamedEntities: 87, otherProfiles: [] } } });
    expect(await screen.findByRole('heading', { name: 'Model canvas' })).toBeInTheDocument();
    await screen.findByRole('group', { name: 'Model canvas' });
    const modelCalls = () => authFetch.mock.calls.filter(([u]) => u.startsWith('/api/org-truth/model')).length;
    const before = modelCalls();
    await userEvent.click(screen.getByRole('button', { name: 'Rename Project' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Project' }), 's{Enter}');
    await waitFor(() => expect(modelCalls()).toBe(before + 1));
  });

  it('sends the include-closed filter to the API', async () => {
    const { authFetch } = render();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Include closed' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/model?includeClosed=1'));
  });

  it('copies the model as Mermaid text', async () => {
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Copy as Mermaid' }));
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('t_Project -->|"owner 85"| t_Person'));
  });

  it('shows an empty model with the import action', async () => {
    const { onImport } = render({ routes: { '/api/org-truth/model': { entityTypes: [] } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Import additional information' }));
    expect(onImport).toHaveBeenCalled();
    expect(screen.getByText('No model yet')).toBeInTheDocument();
  });

  it('says 501 is not available yet', async () => {
    render({ routes: { '/api/org-truth/model': jsonResponse({}, { ok: false, status: 501 }) } });
    expect(await screen.findByText('Model — not available yet')).toBeInTheDocument();
  });
});
