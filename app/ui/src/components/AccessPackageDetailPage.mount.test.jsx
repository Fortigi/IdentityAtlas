// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  cleanup,
  userEvent,
} from '@ui/test-utils/renderWithProviders';
import AccessPackageDetailPage from '@ui/components/AccessPackageDetailPage';

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const pkg = (over = {}) => ({
  attributes: { id: 'ap1', displayName: 'Finance Access', catalogName: 'Finance', ...over.attributes },
  ...over,
});

function renderPage({ body = pkg(), risk = null, pkgOk = true, onOpenDetail = () => {} } = {}) {
  const seen = [];
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    seen.push(s);
    if (s.includes('/api/risk-scores/business-roles/')) {
      return risk ?? jsonResponse(null, { ok: false, status: 404 });
    }
    // AccessPackageGovernance fetches three sub-resources off the same prefix and expects arrays;
    // they must be matched BEFORE the package itself, or it receives the package object and throws
    // "(reviews || []) is not iterable".
    if (/\/api\/access-package\/[^/]+\/(policies|reviews|requests|owners|participants)$/.test(s)) return [];
    if (/\/api\/access-package\/[^/]+\/owners\/suggestions$/.test(s)) return {};
    if (s.includes('/api/access-package/')) {
      return pkgOk ? body : jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
    }
    return undefined;
  });
  const r = renderWithProviders(
    <AccessPackageDetailPage accessPackageId="ap1" onClose={() => {}} onOpenDetail={onOpenDetail} />,
    { auth: { authFetch } },
  );
  return { ...r, seen };
}

describe('AccessPackageDetailPage header', () => {
  it('renders the package name', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Finance Access' })).toBeInTheDocument();
  });

  // A catalog is a context (migration 117): its name opens that context.
  it('opens the catalog context from the catalog name', async () => {
    const onOpenDetail = vi.fn();
    renderPage({ body: pkg({ attributes: { catalogId: 'cat-1', catalogName: 'Finance catalog' } }), onOpenDetail });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Finance catalog' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'cat-1', 'Finance catalog');
  });

  it('shows the catalog as plain text when it has no id to open', async () => {
    renderPage({ body: pkg({ attributes: { catalogName: 'Legacy catalog' } }) });
    expect(await screen.findByText("Catalog: Legacy catalog")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legacy catalog' })).toBeNull();
  });

  it('labels the role by type only, next to its name', async () => {
    renderPage({ body: pkg({ accessModel: { control: 'Manual', waysIn: ['Request', 'Assigned'], waysOut: ['Review'] } }) });
    expect(await screen.findByTestId('role-type')).toHaveTextContent(/^Manual$/);
    expect(screen.queryByText('Gained by')).toBeNull();
    expect(screen.queryByText('Assigned')).toBeNull();
  });

  // A role deleted in the source used to look identical to its live re-created
  // twin of the same name; only an attribute row told them apart.
  it('badges a role deleted in the source next to the name', async () => {
    const body = pkg();
    body.attributes.deletedAt = '2026-09-08T14:32:00Z';
    renderPage({ body });
    const heading = await screen.findByRole('heading', { name: 'Finance Access' });
    expect(heading.parentElement).toHaveTextContent('Deleted in source');
  });

  it('shows no deleted badge for a live role', async () => {
    renderPage();
    const heading = await screen.findByRole('heading', { name: 'Finance Access' });
    expect(heading.parentElement).not.toHaveTextContent('Deleted in source');
  });

  it('surfaces an error when the package is missing', async () => {
    renderPage({ pkgOk: false });
    expect(await screen.findByText(/HTTP 404|could(n.t| not) load/i)).toBeInTheDocument();
  });
});

describe('AccessPackageDetailPage lifecycle', () => {
  it('lists review status, date, reviewer on Lifecycle and the category in the header', async () => {
    renderPage({
      body: pkg({
        complianceStatus: 'Overdue',
        daysOverdue: 12,
        lastReviewDate: '2026-03-01T00:00:00Z',
        lastReviewedBy: 'auditor@example.com',
        category: { name: 'Finance', color: '#1d4ed8' },
      }),
    });

    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Lifecycle' }));
    expect(await screen.findByText(/Overdue \(12d ago\)/)).toBeInTheDocument();
    expect(screen.getByText(/by auditor@example\.com/)).toBeInTheDocument();
    // Category pill uses the contrast-safe tint rather than the raw hex as text.
    const cat = screen.getAllByText('Finance').find(el => (el.getAttribute('style') || '').includes('background-color'));
    expect(cat).toBeTruthy();
  });

  it('shows no review status when there is no governance data', async () => {
    renderPage();
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Lifecycle' }));
    expect(await screen.findByText('No regular review.')).toBeInTheDocument();
    expect(screen.queryByText('Last review')).not.toBeInTheDocument();
  });
});

describe('AccessPackageDetailPage risk', () => {
  it('offers the Risk tab once the business-role score resolves', async () => {
    renderPage({ risk: { riskScore: 55, riskTier: 'Medium' } });
    expect(await screen.findByRole('tab', { name: /^Risk$/i })).toBeInTheDocument();
  });

  it('opens the risk section from its tab', async () => {
    renderPage({ risk: { riskScore: 55, riskTier: 'Medium' } });
    await userEvent.setup().click(await screen.findByRole('tab', { name: /^Risk$/i }));
    expect(await screen.findByText('55')).toBeInTheDocument();
  });

  it('omits the Risk tab when no score exists for the package', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Finance Access' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Risk$/i })).not.toBeInTheDocument();
  });
});
