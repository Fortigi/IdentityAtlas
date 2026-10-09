// @vitest-environment jsdom
//
// The Organisation page shell: four tabs, the import button only for someone who
// may import, and the wizard opening and closing from that button.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import OrgTruthPage from '@ui/components/orgtruth/OrgTruthPage';
import { ORG_TABS } from '@ui/components/orgtruth/orgTabs';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function renderPage({ auth = IMPORTER, features = { orgTruth: true } } = {}) {
  return renderWithProviders(<OrgTruthPage onOpenDetail={() => {}} />, { auth: { authFetch: makeAuthFetch({}), ...auth }, features });
}

describe('OrgTruthPage', () => {
  it('shows the four tabs and starts on Sources', () => {
    renderPage();
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(ORG_TABS.map(t => t.label));
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Organisation');
  });

  it('switches panels when a tab is clicked', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^Review — not built yet/)).toBeInTheDocument();
  });

  it('offers the import button only to someone who may import', () => {
    renderPage({ auth: READER });
    expect(screen.queryByRole('button', { name: 'Import organisation truth' })).toBeNull();
    renderPage({ auth: IMPORTER, features: { orgTruth: false } });
    expect(screen.queryByRole('button', { name: 'Import organisation truth' })).toBeNull();
    renderPage();
    expect(screen.getByRole('button', { name: 'Import organisation truth' })).toBeInTheDocument();
  });

  it('opens the wizard from the button and closes it again from Cancel', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Import organisation truth' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Import organisation truth' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /New import/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('radio', { name: /New import/ })).toBeNull();
  });
});
