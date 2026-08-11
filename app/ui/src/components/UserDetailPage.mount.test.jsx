// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  waitFor,
} from '@ui/test-utils/renderWithProviders';
import UserDetailPage from '@ui/components/UserDetailPage';

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true }));
});
afterEach(() => vi.restoreAllMocks());

const user = (over = {}) => ({
  attributes: {
    id: 'u1',
    displayName: 'Ada Lovelace',
    userPrincipalName: 'ada@example.com',
    principalType: 'Member',
    jobTitle: 'Analyst',
    department: 'Engineering',
    companyName: 'Fortigi',
    systemDisplayName: 'Entra ID',
    ...over,
  },
  tags: [],
});

// The page fires two side fetches of its own (identity link, manager) alongside the entity fetch.
function renderPage({ body = user(), identity = null, manager = null, userOk = true } = {}) {
  const seen = [];
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    seen.push(s);
    if (s.includes('/api/identities/by-user/')) return identity ?? jsonResponse(null, { ok: false, status: 404 });
    if (s.includes('/api/org-chart/user/')) return manager ?? jsonResponse(null, { ok: false, status: 404 });
    if (s.includes('/api/user/')) {
      return userOk ? body : jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
    }
    return undefined;
  });
  const r = renderWithProviders(
    <UserDetailPage userId="u1" onClose={() => {}} onOpenDetail={() => {}} />,
    { auth: { authFetch } },
  );
  return { ...r, seen };
}

describe('UserDetailPage header', () => {
  it('renders the name, principal type, UPN, system and the job/department/company line', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', { name: 'Ada Lovelace' });
    // Scoped to the header: `principalType` is not hidden, so it also appears as an attribute row.
    expect(heading.parentElement).toHaveTextContent('Member');
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/System: Entra ID/)).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Fortigi')).toBeInTheDocument();
  });

  it('falls back to the email when there is no UPN, and to systemId when there is no system name', async () => {
    renderPage({ body: user({ userPrincipalName: undefined, email: 'ada@old.example', systemDisplayName: undefined, systemId: 'csv-1' }) });

    expect(await screen.findByText('ada@old.example')).toBeInTheDocument();
    expect(screen.getByText(/System: csv-1/)).toBeInTheDocument();
  });

  it('renders an avatar initial even when the display name is missing', async () => {
    renderPage({ body: user({ displayName: undefined }) });

    // `(displayName || '?')[0]` — the fallback, not a crash.
    expect(await screen.findByText('?')).toBeInTheDocument();
  });

  it('marks a principal deleted in the source system', async () => {
    renderPage({ body: user({ deletedAt: '2026-01-02T03:04:05Z' }) });

    expect(await screen.findByText('Deleted in source')).toBeInTheDocument();
  });

  it('shows the last sign-in when the payload carries activity', async () => {
    const body = user();
    body.lastActivity = { lastActivityDateTime: '2026-05-04T09:00:00Z' };
    renderPage({ body });

    expect(await screen.findByText(/Last sign-in:/)).toBeInTheDocument();
  });
});

describe('UserDetailPage side fetches', () => {
  it('asks for the linked identity and the manager alongside the user', async () => {
    const { seen } = renderPage();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    await waitFor(() => {
      expect(seen.some(u => u.includes('/api/identities/by-user/u1'))).toBe(true);
      expect(seen.some(u => u.includes('/api/org-chart/user/u1/manager'))).toBe(true);
    });
  });

  it('renders normally when both side fetches 404', async () => {
    renderPage();
    // Neither is required for the page to work — a missing identity link or manager is normal.
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });
});

describe('UserDetailPage risk tab', () => {
  it('offers the Risk tab only when the principal carries a score', async () => {
    renderPage({ body: user({ riskScore: 41 }) });
    expect(await screen.findByRole('tab', { name: /^Risk$/i })).toBeInTheDocument();
  });

  it('omits the Risk tab when there is no score', async () => {
    renderPage();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Risk$/i })).not.toBeInTheDocument();
  });
});
