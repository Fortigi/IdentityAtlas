// @vitest-environment jsdom
// Selecting a nested node of a derived tree shows that node on the right —
// the demo's Organisation › Accounts: department roots from one rule, and a
// manager hierarchy whose "Engineering (Bob Chen)" sits two levels down.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import ContextsPage from './ContextsPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

const unit = (id, displayName, extra = {}) => ({
  id, displayName, variant: 'generated', targetType: 'Principal', contextCategory: 'OrganizationalUnit',
  directMemberCount: 1, totalMemberCount: 1, ...extra,
});
const MH = { sourceAlgorithmName: 'manager-hierarchy', sourceAlgorithmDisplayName: 'Manager Hierarchy', contextType: 'ManagerHierarchy', scopeSystemId: 1, scopeSystemName: 'Demo EntraID' };
const DEPTS = unit('dept-root', 'Departments', { contextType: 'Department', sourceAlgorithmName: 'department-from-principal', sourceAlgorithmDisplayName: 'Department from Principal', totalMemberCount: 9 });
const ORG = unit('org', 'Organization', { ...MH, totalMemberCount: 9 });
const CEO = unit('ceo', 'Alice Ceo', { ...MH, parentContextId: 'org', parentDisplayName: 'Organization' });
const ENG = unit('eng', 'Engineering (Bob Chen)', { ...MH, parentContextId: 'ceo', parentDisplayName: 'Alice Ceo' });
const ALL = { 'dept-root': DEPTS, org: ORG, ceo: CEO, eng: ENG };
const SUBTREES = {
  'dept-root': [{ ...DEPTS, children: [] }],
  org: [{ ...ORG, children: [{ ...CEO, children: [{ ...ENG, children: [] }] }] }],
};

function api({ detail = (id) => (ALL[id] ? { attributes: ALL[id], subContexts: [], roles: [] } : undefined) } = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    const tree = /^\/api\/contexts\/tree\?root=([^&]+)/.exec(u);
    if (tree) return SUBTREES[decodeURIComponent(tree[1])] || [];
    if (u === '/api/contexts') return { data: [DEPTS, ORG] };
    const m = /^\/api\/contexts\/([^/?]+)(\/[^?]*)?/.exec(u);
    if (!m) return undefined;
    const [, id, sub] = m;
    if (!sub) return detail(id);
    if (sub === '/members') return { total: 0, data: [] };
    if (sub === '/relationships' || sub === '/roles') return [];
    return undefined;
  });
}

function mount(opts) {
  sessionStorage.setItem('iatlas.contexts.selected', JSON.stringify({ 'OrganizationalUnit:Principal': 'org' }));
  const authFetch = api(opts);
  renderWithProviders(h(ContextsPage, { onOpenDetail: vi.fn() }), { auth: { authFetch } });
  return { authFetch, user: userEvent.setup() };
}

const pane = () => screen.getByTestId('context-tree-pane');
const detailPane = () => screen.getByTestId('context-detail-pane');
const node = (name) => within(pane()).getAllByRole('button').find(b =>
  b.closest('li') && !b.hasAttribute('aria-expanded') && !b.hasAttribute('aria-haspopup') && b.textContent.startsWith(name));

describe('ContextsPage — a nested node of a derived tree', () => {
  it('selecting "Engineering (Bob Chen)" shows its detail on the right', async () => {
    const { user } = mount();
    await waitFor(() => expect(node('Engineering (Bob Chen)')).toBeTruthy());
    await user.click(node('Engineering (Bob Chen)'));
    await waitFor(() => expect(within(detailPane()).getByRole('heading', { level: 2 })).toHaveTextContent('Engineering (Bob Chen)'));
    expect(within(detailPane()).getByTestId('context-subtitle')).toHaveTextContent('derived by the Manager Hierarchy rule');
  });

  it('a failed read of the selected node shows the failure, never a blank pane', async () => {
    const { user } = mount({ detail: (id) => (id === 'eng' ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 }) : { attributes: ALL[id], subContexts: [], roles: [] }) });
    await waitFor(() => expect(node('Engineering (Bob Chen)')).toBeTruthy());
    await user.click(node('Engineering (Bob Chen)'));
    expect(await within(detailPane()).findByText('Failed to load context')).toBeInTheDocument();
    expect(within(detailPane()).getByText('HTTP 500')).toBeInTheDocument();
  });

  it('a failed members read says so instead of passing for an empty unit', async () => {
    sessionStorage.setItem('iatlas.contexts.selected', JSON.stringify({ 'OrganizationalUnit:Principal': 'eng' }));
    const base = api();
    const authFetch = vi.fn((url, opts) => (String(url).startsWith('/api/contexts/eng/members')
      ? Promise.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 503 }))
      : base(url, opts)));
    renderWithProviders(h(ContextsPage, { onOpenDetail: vi.fn() }), { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Members could not be loaded (HTTP 503).');
    expect(within(detailPane()).queryByText('No members found.')).toBeNull();
  });

  it('says it is loading, rather than showing nothing, while the trees are read', async () => {
    let answer;
    const base = api();
    const authFetch = vi.fn((url, opts) => (String(url) === '/api/contexts'
      ? new Promise(res => { answer = () => res(jsonResponse({ data: [DEPTS, ORG] })); })
      : base(url, opts)));
    renderWithProviders(h(ContextsPage, { onOpenDetail: vi.fn() }), { auth: { authFetch } });
    expect(screen.getByTestId('context-detail-empty')).toHaveTextContent('Loading…');
    answer();
    await waitFor(() => expect(within(detailPane()).getByRole('heading', { level: 2 })).toHaveTextContent('Departments'));
  });
});
