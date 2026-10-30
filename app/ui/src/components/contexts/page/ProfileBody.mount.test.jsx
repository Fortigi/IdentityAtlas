// @vitest-environment jsdom
// The body of a unit's page, wired as the detail page does it: the analyst's
// attention line and where each of its parts leads (to decide → People filtered
// to the people to decide, or What we know when it is about the unit; to review →
// the review drawer; to correct → the change requests), the sections in reading
// order, and what a business reader gets instead. Invented names.
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Organisation knowledge (Admin → Experimental) is off by default; on here unless a test switches it off.
const knowledge = vi.hoisted(() => ({ on: true }));
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => knowledge.on }));
import { createElement as h } from 'react';
import ClaimsProvider from '@ui/components/contexts/interviews/ClaimsProvider';
import ProfileBody from './ProfileBody';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { renderWithProviders, makeAuthFetch, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = { id: 'c-unit', displayName: 'Harbour Office', contextCategory: 'OrganizationalUnit', targetType: 'Principal', variant: 'synced' };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' };
const side = (id, claimKind, statement) => ({ kind: 'claim', statement, claim: { id, claimKind, status: 'proposed', ...SRC } });
const PERSON_CON = { id: 'memberNotListed:m-dana', rule: 'memberNotListed', status: 'open', claimIds: ['m-dana'], claim: side('m-dana', 'membership', 'Interview: Dana Said is a member'), other: { kind: 'fact', statement: 'The list does not list Dana Said', source: 'The list' } };
const UNIT_CON = { id: 'property:p-sector', rule: 'property', status: 'open', claimIds: ['p-sector'], claim: side('p-sector', 'property', 'Interview: sector is Shipping'), other: { kind: 'fact', statement: 'sector is Logistics', source: 'The list' } };
const CLAIMS = [
  { id: 'm-dana', claimKind: 'membership', attribute: 'current', value: 'is in it', status: 'proposed', subjectName: 'Dana Said', ...SRC },
  { id: 'p-sector', claimKind: 'property', attribute: 'sector', value: 'Shipping', status: 'proposed', ...SRC },
];
const REQUEST = { id: 'r-1', status: 'open', summary: 'Remove Bob Sample from Harbour Office', targetName: 'The list', raisedBy: 'unknown', raisedAt: '2026-10-23T09:00:00Z' };

function mount({ attrs = UNIT, analyst = true, contradictions = [PERSON_CON, UNIT_CON], auth = {}, people = [] } = {}) {
  const urls = [];
  const authFetch = makeAuthFetch((url) => {
    const u = String(url);
    urls.push(u);
    if (u === `/api/contexts/${attrs.id}/claims`) return { data: CLAIMS, contradictions, accountableDoubt: null };
    if (u === `/api/contexts/${attrs.id}/interviews`) return { data: [{ id: 'iv-1', ...SRC, sourceKind: 'interview', extractionStatus: 'done', proposed: 2, confirmed: 0 }] };
    if (u.startsWith(`/api/contexts/${attrs.id}/people`)) return { data: people, total: people.length, counts: { current: people.length, former: 0, all: people.length, decide: 1 }, linkedResources: 0 };
    if (u.startsWith('/api/change-requests')) return { items: [REQUEST] };
    if (u === `/api/contexts/${attrs.id}/relationships`) return [];
    return undefined;
  });
  const members = { contextId: attrs.id, attrs, authFetch, members: [{ id: 'r-1', displayName: 'SG-Planner', resourceType: 'Group' }], memberTotal: 1, membersLoading: false, membersError: null, memberPage: 0, onMemberPageChange: vi.fn(), pageSize: 50, includeDescendants: false, onIncludeDescendantsChange: vi.fn(), memberSearch: '', onMemberSearchChange: vi.fn(), onMembersChanged: vi.fn() };
  const profile = attrs.contextCategory === 'LogicalApplication' ? PROFILES.LogicalApplication : PROFILES.OrganizationalUnit;
  renderWithProviders(h(ClaimsProvider, { contextId: attrs.id }, h(ProfileBody, {
    contextId: attrs.id, attrs, profile, subContexts: [{ id: 's-1', displayName: 'Harbour East', memberCount: 4 }], analyst,
    membersEditable: false, openEntity: vi.fn(), onOpenDetail: vi.fn(), peopleVersion: 0, onMembersChanged: vi.fn(), members,
  })), { auth: { authFetch, ...auth } });
  return { urls, user: userEvent.setup() };
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

const line = () => screen.findByTestId('attention-line');

describe('the attention line', () => {
  it('says what waits: to decide, to review, to correct in the source — and the sections follow in reading order', async () => {
    mount();
    expect(await line()).toHaveTextContent(/^2 to decide·2 to review·1 to correct in the source$/);
    const regions = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'));
    expect(regions).toEqual(['People', 'What we know', 'Sources', 'Change requests', 'Sub-units']);
  });

  it('"to decide" with a person to decide filters People to them', async () => {
    const { urls, user } = mount();
    await user.click(within(await line()).getByRole('button', { name: '2 to decide' }));
    await waitFor(() => expect(urls).toContain('/api/contexts/c-unit/people?filter=decide&limit=100&offset=0'));
    expect(within(screen.getByRole('region', { name: 'People' })).getByRole('button', { name: 'To decide 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('"to decide" about the unit only opens What we know, where it is decided', async () => {
    const { urls, user } = mount({ contradictions: [UNIT_CON] });
    await user.click(within(await line()).getByRole('button', { name: '1 to decide' }));
    const know = screen.getByRole('region', { name: 'What we know' });
    expect(within(know).getByRole('button', { name: /^What we know/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(know).getByRole('region', { name: 'Contradictions' })).toHaveTextContent('Interview: sector is Shipping');
    expect(urls.some(u => u.includes('filter=decide'))).toBe(false);
  });

  it('"to review" opens the drawer with every proposed claim; "to correct" opens the change requests', async () => {
    const { user } = mount();
    await user.click(within(await line()).getByRole('button', { name: '2 to review' }));
    const drawer = await screen.findByRole('dialog', { name: 'To review' });
    expect(within(drawer).getAllByTestId('claim-review-row')).toHaveLength(2);
    await user.click(within(drawer).getByRole('button', { name: 'Close the review' }));
    await user.click(within(await line()).getByRole('button', { name: '1 to correct in the source' }));
    const changes = screen.getByRole('region', { name: 'Change requests' });
    expect(within(changes).getByRole('button', { name: /^Change requests/ })).toHaveAttribute('aria-expanded', 'true');
    expect(changes).toHaveTextContent('Remove Bob Sample from Harbour Office');
    expect(document.getElementById('change-requests-c-unit')).toBe(changes);
  });
});

describe('a business reader', () => {
  it('gets People, What we know and the sub-units: no attention line, no sources, no change requests', async () => {
    const { urls } = mount({ analyst: false, auth: { hasWildcard: false, permissions: new Set(['data.read']) } });
    await waitFor(() => expect(urls.some(u => u.startsWith('/api/contexts/c-unit/people'))).toBe(true));
    expect(screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['People', 'What we know', 'Sub-units']);
    expect(screen.queryByTestId('attention-line')).toBeNull();
    expect(urls.some(u => u.startsWith('/api/change-requests'))).toBe(false);
  });
});

describe('an application', () => {
  it('lists its resources under its own word, and shows People only when a source named someone', async () => {
    const app = { id: 'c-app', displayName: 'Planner', contextCategory: 'LogicalApplication', targetType: 'Resource' };
    const { urls } = mount({ attrs: app, contradictions: [] });
    expect(await screen.findByRole('region', { name: 'Resources' })).toHaveTextContent('SG-Planner');
    await waitFor(() => expect(urls.some(u => u.startsWith('/api/contexts/c-app/people'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });
});
