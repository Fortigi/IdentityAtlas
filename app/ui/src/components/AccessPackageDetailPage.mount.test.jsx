// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  cleanup,
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

function renderPage({ body = pkg(), risk = null, pkgOk = true } = {}) {
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
    if (/\/api\/access-package\/[^/]+\/(policies|reviews|requests)$/.test(s)) return [];
    if (s.includes('/api/access-package/')) {
      return pkgOk ? body : jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
    }
    return undefined;
  });
  const r = renderWithProviders(
    <AccessPackageDetailPage accessPackageId="ap1" onClose={() => {}} onOpenDetail={() => {}} />,
    { auth: { authFetch } },
  );
  return { ...r, seen };
}

describe('AccessPackageDetailPage header', () => {
  it('renders the package name', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Finance Access' })).toBeInTheDocument();
  });

  it('badges the assignment type next to the name', async () => {
    const heading = await (async () => {
      renderPage({ body: pkg({ assignmentType: 'Direct' }) });
      return screen.findByRole('heading', { name: 'Finance Access' });
    })();
    expect(heading.parentElement).toHaveTextContent('Direct');
  });

  it('surfaces an error when the package is missing', async () => {
    renderPage({ pkgOk: false });
    expect(await screen.findByText(/HTTP 404|could(n.t| not) load/i)).toBeInTheDocument();
  });
});

describe('AccessPackageDetailPage overview panel', () => {
  it('lists review status, dates, reviewer and category when governance data is present', async () => {
    renderPage({
      body: pkg({
        assignmentType: 'Direct',
        complianceStatus: 'Overdue',
        daysOverdue: 12,
        lastReviewDate: '2026-03-01T00:00:00Z',
        lastReviewedBy: 'auditor@example.com',
        category: { name: 'Finance', color: '#1d4ed8' },
      }),
    });

    expect(await screen.findByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Review status')).toBeInTheDocument();
    expect(screen.getByText(/Overdue \(12d ago\)/)).toBeInTheDocument();
    expect(screen.getByText('auditor@example.com')).toBeInTheDocument();
    // Category pill uses the contrast-safe tint rather than the raw hex as text.
    const cat = screen.getAllByText('Finance').find(el => (el.getAttribute('style') || '').includes('background-color'));
    expect(cat).toBeTruthy();
  });

  it('omits the overview panel entirely when there is no governance data', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Finance Access' })).toBeInTheDocument();
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
  });
});

describe('AccessPackageDetailPage risk', () => {
  it('offers the Risk tab once the business-role score resolves', async () => {
    renderPage({ risk: { riskScore: 55, riskTier: 'Medium' } });
    expect(await screen.findByRole('tab', { name: /^Risk$/i })).toBeInTheDocument();
  });

  it('omits the Risk tab when no score exists for the package', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Finance Access' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Risk$/i })).not.toBeInTheDocument();
  });
});
