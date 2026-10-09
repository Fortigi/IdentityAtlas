// @vitest-environment jsdom
//
// The Organisation page shell: four tabs, the import button only for someone who
// may import, and the wizard opening (new, or in repeat mode from a source's
// "Import again") and closing. The wizard itself is workstream T5's and is
// replaced by a probe here, so this test pins only what the page hands it.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import { ORG_TABS } from '@ui/components/orgtruth/orgTabs';

vi.mock('@ui/components/orgtruth/wizard/ImportWizard', () => ({
  default: ({ onClose, profileId }) => (
    <div data-testid="wizard">
      wizard profile={profileId ?? 'none'}
      <button type="button" onClick={() => onClose(false)}>Cancel wizard</button>
      <button type="button" onClick={() => onClose(true)}>Finish wizard</button>
    </div>
  ),
}));
const { default: OrgTruthPage } = await import('@ui/components/orgtruth/OrgTruthPage');

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const ROUTES = {
  '/api/org-truth/sources': [{ id: 's1', displayName: 'Contoso projects', kind: 'list', observedAt: '2026-10-01T09:00:00Z', runCount: 1 }],
  '/api/org-truth/runs': [{ id: 'r1', sourceId: 's1', profileId: 'p7', mode: 'full', status: 'completed', createdAt: '2026-10-01T10:00:00Z' }],
  '/api/org-truth/review': { data: [], total: 0 },
  '/api/org-truth/model': { entityTypes: [] },
};

function renderPage({ auth = IMPORTER, features = { orgTruth: true } } = {}) {
  const authFetch = makeAuthFetch(ROUTES);
  renderWithProviders(<OrgTruthPage onOpenDetail={() => {}} />, { auth: { authFetch, ...auth }, features });
  return { authFetch };
}

describe('OrgTruthPage', () => {
  it('shows the four tabs and starts on Sources', async () => {
    renderPage();
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(ORG_TABS.map(t => t.label));
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Organisation');
    expect(await screen.findByRole('button', { name: 'Contoso projects' })).toBeInTheDocument();
  });

  it('switches panels when a tab is clicked', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('has exactly one import button, in the Sources tab, and only for someone who may import', async () => {
    renderPage({ auth: READER });
    await screen.findByRole('button', { name: 'Contoso projects' });
    expect(screen.queryByRole('button', { name: 'Import organisation truth' })).toBeNull();
    renderPage({ auth: IMPORTER, features: { orgTruth: false } });
    await screen.findAllByRole('button', { name: 'Contoso projects' });
    expect(screen.queryByRole('button', { name: 'Import organisation truth' })).toBeNull();
    renderPage();
    await screen.findAllByRole('button', { name: 'Contoso projects' });
    expect(screen.getAllByRole('button', { name: 'Import organisation truth' })).toHaveLength(1);
  });

  it('opens a new import from the Sources tab button and closes it without refreshing', async () => {
    const { authFetch } = renderPage();
    await screen.findByRole('button', { name: 'Contoso projects' });
    await userEvent.click(screen.getByRole('button', { name: 'Import organisation truth' }));
    expect(screen.getByTestId('wizard')).toHaveTextContent('wizard profile=none');
    const loads = authFetch.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel wizard' }));
    expect(screen.queryByTestId('wizard')).toBeNull();
    expect(authFetch.mock.calls.length).toBe(loads);
  });

  it('opens the wizard in repeat mode from Import again and refreshes the panel after an import', async () => {
    const { authFetch } = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Import again' }));
    expect(screen.getByTestId('wizard')).toHaveTextContent('wizard profile=p7');
    const sourceLoads = () => authFetch.mock.calls.filter(c => c[0] === '/api/org-truth/sources').length;
    const before = sourceLoads();
    await userEvent.click(screen.getByRole('button', { name: 'Finish wizard' }));
    expect(screen.queryByTestId('wizard')).toBeNull();
    await screen.findByRole('button', { name: 'Contoso projects' });
    expect(sourceLoads()).toBe(before + 1);
  });
});
