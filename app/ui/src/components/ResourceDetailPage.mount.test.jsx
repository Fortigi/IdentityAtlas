// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  fireEvent,
} from '@ui/test-utils/renderWithProviders';
import ResourceDetailPage from '@ui/components/ResourceDetailPage';

// useFeatures reads /api/features through the global fetch, not authFetch.
beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true }));
});
afterEach(() => vi.restoreAllMocks());

const resource = (over = {}) => ({
  attributes: {
    id: 'r1',
    displayName: 'Finance Admins',
    resourceType: 'Group',
    description: 'Owns the ledger',
    systemId: 'entra',
    ...over,
  },
  tags: [],
});

// Serves /api/resources/:id, and optionally 404s it so the /api/group/:id fallback is exercised.
function renderPage({ body = resource(), resourcesOk = true, groupBody = null, onOpenDetail = () => {} } = {}) {
  const seen = [];
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    seen.push(s);
    if (s.includes('/api/resources/')) {
      return resourcesOk ? body : jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
    }
    if (s.includes('/api/group/')) {
      return groupBody ?? jsonResponse({ error: 'gone' }, { ok: false, status: 404 });
    }
    return undefined;
  });
  const r = renderWithProviders(
    <ResourceDetailPage resourceId="r1" onClose={() => {}} onOpenDetail={onOpenDetail} />,
    { auth: { authFetch } },
  );
  return { ...r, seen };
}

describe('ResourceDetailPage header', () => {
  it('renders the name, the resource-type badge and the description', async () => {
    renderPage();

    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText('Owns the ledger')).toBeInTheDocument();
    expect(screen.getByText(/System: entra/)).toBeInTheDocument();
  });

  it('falls back to groupTypeCalculated when resourceType is absent', async () => {
    renderPage({ body: resource({ resourceType: undefined, groupTypeCalculated: 'Security' }) });

    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('marks a resource deleted in the source system', async () => {
    renderPage({ body: resource({ deletedAt: '2026-01-02T03:04:05Z' }) });

    expect(await screen.findByText('Deleted in source')).toBeInTheDocument();
  });

  it('renders tag pills using the contrast-safe tint, not the raw colour as text', async () => {
    const body = resource();
    body.tags = [{ id: 't1', name: 'Prod', color: '#1d4ed8' }];
    renderPage({ body });

    const pill = await screen.findByText('Prod');
    const style = pill.getAttribute('style') || '';
    expect(style).toMatch(/background-color/);
    expect(style).not.toContain('#1d4ed820');   // the retired alpha-hex hack
  });
});

describe('ResourceDetailPage data source', () => {
  it('falls back to the legacy /api/group endpoint when /api/resources 404s', async () => {
    const { seen } = renderPage({ resourcesOk: false, groupBody: resource({ displayName: 'Legacy Group' }) });

    expect(await screen.findByText('Legacy Group')).toBeInTheDocument();
    expect(seen.some(u => u.includes('/api/resources/'))).toBe(true);
    expect(seen.some(u => u.includes('/api/group/'))).toBe(true);
  });

  it('surfaces an error when neither endpoint has the resource', async () => {
    renderPage({ resourcesOk: false });

    // EntityDetailPage's error guard, not a blank page.
    expect(await screen.findByText(/HTTP 404|could(n.t| not) load/i)).toBeInTheDocument();
  });
});

describe('ResourceDetailPage attributes', () => {
  it('merges extendedAttributes supplied as a JSON string into the attribute rows', async () => {
    renderPage({ body: resource({ extendedAttributes: JSON.stringify({ owner: 'ops-team' }) }) });

    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    expect(await screen.findByText('ops-team')).toBeInTheDocument();
  });

  it('ignores extendedAttributes that are not valid JSON instead of crashing', async () => {
    renderPage({ body: resource({ extendedAttributes: '{not json' }) });

    // The page still renders; the unparseable blob is simply dropped.
    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
  });
});

describe('ResourceDetailPage risk tab', () => {
  it('offers the Risk tab only when the resource carries a score', async () => {
    renderPage({ body: resource({ riskScore: 72 }) });
    expect(await screen.findByRole('tab', { name: /^Risk$/i })).toBeInTheDocument();
  });

  it('omits the Risk tab when the resource has no score', async () => {
    renderPage();
    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Risk$/i })).not.toBeInTheDocument();
  });
});

describe('ResourceDetailPage owner', () => {
  const withOwners = (owners) => ({ ...resource(), owners });

  it('names the owner in the header and opens their page on click', async () => {
    const onOpenDetail = vi.fn();
    renderPage({
      body: withOwners([{ principalId: 'p1', displayName: 'Ada Lovelace', email: 'ada@x', via: 'link' }]),
      onOpenDetail,
    });

    const owner = await screen.findByRole('button', { name: 'Ada Lovelace' });
    expect(screen.getByText('Owner:')).toBeInTheDocument();
    expect(owner).toHaveAttribute('title', 'Owner in the source system');
    fireEvent.click(owner);
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p1', 'Ada Lovelace');
  });

  it('lists several owners, and says when one was matched from the name the source gave', async () => {
    renderPage({ body: withOwners([
      { principalId: 'p1', displayName: 'Ada Lovelace', via: 'link' },
      { principalId: 'p2', displayName: null, via: 'reference' },
    ]) });

    expect(await screen.findByText('Owners:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeInTheDocument();
    // No name on the account: its id still gives something to click.
    expect(screen.getByRole('button', { name: 'p2' }))
      .toHaveAttribute('title', 'Named as owner by the source system, matched to this account');
  });

  it('shows an owner only the source knows as plain text, with nothing to open', async () => {
    renderPage({ body: withOwners([{ principalId: null, displayName: 'Gone Person', via: 'source' }]) });

    const owner = await screen.findByText('Gone Person');
    expect(owner).toHaveAttribute('title', 'Named as owner by the source system; no account we hold matches');
    expect(screen.queryByRole('button', { name: 'Gone Person' })).not.toBeInTheDocument();
  });

  it('says nothing about an owner when the resource has none', async () => {
    renderPage({ body: withOwners([]) });
    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    expect(screen.queryByText(/^Owners?:$/)).not.toBeInTheDocument();
    renderPage();
    expect(screen.queryByText(/^Owners?:$/)).not.toBeInTheDocument();
  });

  it('offers the owners in the relationship graph', async () => {
    renderPage({ body: withOwners([{ principalId: 'p1', displayName: 'Ada Lovelace', via: 'link' }]) });
    fireEvent.click(await screen.findByRole('tab', { name: /Relationships/i }));
    expect(await screen.findByText('Owners')).toBeInTheDocument();
  });
});
