// @vitest-environment jsdom
// A member marked former by a decision: an interview said Led left, the analyst
// decided "the interview is right", the uploaded list still has him. The members
// list leaves him out with a note that shows him struck through on request;
// Previous members lists him with the decision, what it means for the source,
// and Undo. Invented names throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h, useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import ContextRelationshipsTab from '@ui/components/ContextRelationshipsTab';
import ClaimsProvider from './ClaimsProvider';
import { useContextMembers } from '../useContextMembers';
import { decisionText, overriddenNoteText, overriddenRowText, STILL_LISTED_HINT } from './memberInterview.helpers';
import { memberCountText } from '../profiles/variants.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
// Organisation knowledge is behind a flag (off by default); these tests are about it.
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => true }));

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.txt', proposedBy: 'model' };
const UNIT = { id: 'ctx-1', variant: 'synced', targetType: 'Principal', contextCategory: 'OrganizationalUnit', displayName: 'Klanten', directMemberCount: 12, totalMemberCount: 12 };
const DECISION = { by: 'analist@example.test', at: '2026-10-23T09:30:00.000Z', overrides: 'Klanten (upload)', claimId: 'cl-led' };

beforeEach(() => { global.fetch = vi.fn(async () => jsonResponse({})); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the wording', () => {
  it('the note, the decision, the revealed row and the count in the facts', () => {
    expect(overriddenNoteText(0)).toBe('');
    expect(overriddenNoteText(1)).toBe('1 marked as former by a decision');
    expect(overriddenNoteText(1200)).toBe('1,200 marked as former by a decision');
    expect(decisionText(DECISION)).toBe('Decided by analist@example.test, 2026-10-23: the interview is right — Klanten (upload) still lists them');
    expect(decisionText({ ...DECISION, by: null, at: null }, false)).toBe('Decided: the interview is right');
    expect(overriddenRowText(DECISION)).toBe('Marked former by a decision (overrides Klanten (upload))');
    expect(memberCountText({ ...UNIT, overriddenMemberCount: 1 })).toBe('12 (1 marked former)');
    expect(memberCountText({ directMemberCount: 12, totalMemberCount: 30, overriddenMemberCount: 1 })).toBe('12 in this unit (1 marked former) · 30 including sub-units');
    expect(memberCountText({ ...UNIT, overriddenMemberCount: 0 })).toBe('12');
  });
});

const BEA = { id: 'p-bea', displayName: 'Bea Bakker', email: 'bea@example.test', principalType: 'User', accountEnabled: true, overridden: null, interview: { left: null, role: null, rejoined: null } };
const LED = { id: 'p-led', displayName: 'Led Ledeboer', email: 'led@example.test', principalType: 'User', accountEnabled: true, overridden: DECISION,
  interview: { left: { claimId: 'cl-led', membershipStatus: 'former', status: 'confirmed', ...SRC }, role: null, rejoined: null } };
const PREVIOUS = { linkedResources: 0, data: [
  { key: 'principalId:p-led', principalId: 'p-led', identityId: null, displayName: 'Led Ledeboer', accountDeleted: false, stint: 'left', nowMember: false,
    stillListed: true, decision: DECISION, left: { claimId: 'cl-led', membershipStatus: 'former', status: 'confirmed', ...SRC }, role: null, rejoined: null,
    liveEntitlements: 3, linkedEntitlements: null },
] };

// The members panel inside its claims provider, as the detail page shows it; the toggle is the page's state.
function mountMembers(auth = {}, { undoFails = false } = {}) {
  const calls = [];
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    calls.push([opts.method || 'GET', u]);
    if (u === '/api/contexts/claims/cl-led/undo') {
      return undoFails ? jsonResponse({ error: 'This claim has not been decided' }, { ok: false, status: 409 }) : { claim: { id: 'cl-led', status: 'proposed' }, unmarked: true };
    }
    if (u === '/api/contexts/ctx-1/claims') return { data: [], accountableDoubt: null, contradictions: [] };
    if (u === '/api/contexts/ctx-1/interviews') return { data: [] };
    if (u === '/api/contexts/ctx-1/previous-members') return PREVIOUS;
    return undefined;
  });
  function Page() {
    const [shown, setShown] = useState(false);
    return h(ContextRelationshipsTab, {
      subContexts: [], sectionIds: {}, contextId: 'ctx-1', attrs: UNIT, canEditMembers: false,
      includeDescendants: false, onIncludeDescendantsChange: vi.fn(), memberSearch: '', onMemberSearchChange: vi.fn(),
      members: shown ? [BEA, LED] : [BEA], memberTotal: shown ? 12 : 11, overriddenCount: 1, includeOverridden: shown, onIncludeOverriddenChange: setShown,
      membersLoading: false, membersError: null, memberPage: 0, onMemberPageChange: vi.fn(), pageSize: 50, authFetch, onMembersChanged: vi.fn(), onOpenDetail: vi.fn(),
    });
  }
  renderWithProviders(h(ClaimsProvider, { contextId: 'ctx-1' }, h(Page)), { auth: { authFetch, ...auth } });
  return { calls, user: userEvent.setup() };
}

const memberRow = (name) => within(screen.getByRole('region', { name: 'Members' })).getAllByRole('row').find(r => r.textContent.startsWith(name));

describe('the members list', () => {
  it('says how many a decision marked former, and shows them struck through with the decision on request', async () => {
    const { user } = mountMembers();
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('heading')).toHaveTextContent('Members (11)');
    expect(screen.getByTestId('overridden-note')).toHaveTextContent('1 marked as former by a decision — show');
    expect(memberRow('Led')).toBeUndefined();

    await user.click(within(screen.getByTestId('overridden-note')).getByRole('button', { name: 'show' }));
    expect(within(members).getByRole('heading')).toHaveTextContent('Members (12)');
    const led = memberRow('Led Ledeboer');
    expect(within(led).getByText('Led Ledeboer').className).toContain('line-through');
    const flag = within(led).getByTestId('overridden-flag');
    expect(flag).toHaveTextContent('Marked former by a decision (overrides Klanten (upload))');
    expect(flag.getAttribute('title')).toBe(decisionText(DECISION));
    // The decision says it; the interview's own "left" flag is not repeated.
    expect(within(led).queryByText(/^Interview: former member/)).toBeNull();
    expect(within(memberRow('Bea Bakker')).getByText('Bea Bakker').className).not.toContain('line-through');
    expect(screen.getByRole('button', { name: 'hide' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Previous members', () => {
  it('lists Led with the decision, what to do in the source, the access still held, and Undo', async () => {
    const { calls, user } = mountMembers();
    const section = await screen.findByRole('region', { name: 'Previous members' });
    const decision = within(section).getByTestId('previous-member-decision');
    expect(decision).toHaveTextContent(decisionText(DECISION));
    expect(decision).toHaveTextContent(STILL_LISTED_HINT);
    expect(within(section).getByTestId('previous-member-live')).toHaveTextContent('3 entitlements');

    await user.click(within(decision).getByRole('button', { name: 'Undo decision' }));
    await waitFor(() => expect(calls).toContainEqual(['POST', '/api/contexts/claims/cl-led/undo']));
    // The claims are read again: the contradiction is open again.
    await waitFor(() => expect(calls.filter(c => c[1] === '/api/contexts/ctx-1/claims').length).toBeGreaterThan(1));
  });

  it('an undo the API refuses says why', async () => {
    const { user } = mountMembers({}, { undoFails: true });
    const decision = await screen.findByTestId('previous-member-decision');
    await user.click(within(decision).getByRole('button', { name: 'Undo decision' }));
    expect(await within(decision).findByRole('alert')).toHaveTextContent('This claim has not been decided');
  });

  it('a reader sees the decision without Undo', async () => {
    mountMembers(READER);
    const decision = await screen.findByTestId('previous-member-decision');
    expect(within(decision).queryByRole('button')).toBeNull();
  });
});

describe('useContextMembers', () => {
  it('asks for the marked members only when shown, and keeps the count either way', async () => {
    const urls = [];
    const authFetch = vi.fn(async (url) => {
      urls.push(String(url));
      return jsonResponse({ data: [], total: 11, overriddenCount: 1 });
    });
    const { result } = renderHook(() => useContextMembers(authFetch, 'ctx-1', 0));
    await waitFor(() => expect(result.current.overriddenCount).toBe(1));
    expect(urls[0]).not.toContain('includeOverridden');
    act(() => result.current.setIncludeOverridden(true));
    await waitFor(() => expect(urls.some(u => u.includes('includeOverridden=true'))).toBe(true));
    expect(result.current.includeOverridden).toBe(true);
  });
});
