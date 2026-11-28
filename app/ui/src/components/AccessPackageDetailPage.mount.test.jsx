// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  cleanup,
  userEvent,
  within,
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

// What /composition-reviews answers: nobody reviewed it yet, one group in the role now.
const COMPOSITION = {
  reviews: [], latestReview: null, canReview: true, steps: ['ownership', 'lifecycle', 'contents'], verdicts: ['good', 'needsChange', 'notUnderstood'],
  current: {
    version: 2, takenAt: '2026-11-20T10:00:00Z', role: { displayName: 'Finance Access', holderCount: 3 },
    type: { control: 'Manual', waysIn: [], waysOut: [], reviewGap: false },
    resources: [{ id: 'g1', displayName: 'SG-Finance', resourceType: 'Group', systemName: 'Entra ID' }],
    policies: [], owners: [], participants: [],
  },
};

function renderPage({ body = pkg(), risk = null, pkgOk = true, onOpenDetail = () => {}, features = {} } = {}) {
  const seen = [];
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    seen.push(s);
    if (s.includes('/api/risk-scores/business-roles/')) {
      return risk ?? jsonResponse(null, { ok: false, status: 404 });
    }
    if (/\/api\/access-package\/[^/]+\/composition-reviews$/.test(s)) return COMPOSITION;
    if (/\/api\/access-package\/[^/]+\/resource-roles$/.test(s)) return [];
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
    { auth: { authFetch }, features },
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
    expect(await screen.findByText("Role portfolio: Legacy catalog")).toBeInTheDocument();
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

describe('AccessPackageDetailPage requests & reviews', () => {
  const ON = { compositionReview: true };
  const requestsTab = () => screen.queryByRole('tab', { name: /^Requests & reviews/ });

  it('offers the tab for the composition review alone when the role is neither requested nor reviewed', async () => {
    renderPage({ features: ON });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Requests & reviews/ }));
    expect(await screen.findByRole('region', { name: 'Composition review' })).toBeInTheDocument();
    expect(await screen.findByText('Nobody has reviewed this role yet.')).toBeInTheDocument();
    // Nobody requests it and nothing reviews it: no request/review lists.
    expect(screen.queryByText(/Pending requests/i)).toBeNull();
  });

  it('has no Requests & reviews tab without the flag for a role nobody requests or reviews', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(requestsTab()).toBeNull();
  });

  it('opens the review wizard in place of the review status, on the role\'s own data', async () => {
    renderPage({ features: ON });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Requests & reviews/ }));
    await user.click(await screen.findByRole('button', { name: 'Review this role' }));
    const wizard = await screen.findByTestId('review-wizard');
    expect(screen.queryByTestId('review-status')).toBeNull();
    expect(within(wizard).getByRole('region', { name: 'Who answers for this role now' })).toBeInTheDocument();
    // The lifecycle step reads the role the page already loaded.
    await user.click(within(wizard).getByRole('radio', { name: 'Good' }));
    await user.click(within(wizard).getByRole('button', { name: 'Next' }));
    expect(await within(wizard).findByText('Getting it')).toBeInTheDocument();
  });

  it('shows the requests without a composition review when the flag is off for a requested role', async () => {
    renderPage({ body: pkg({ accessModel: { control: 'Manual', waysIn: ['Request'], waysOut: [] } }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Requests & reviews/ }));
    expect(await screen.findByText(/requests/i, { selector: 'h3,h4,h2' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Composition review' })).toBeNull();
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
