// @vitest-environment jsdom
// Change requests on the context page: what the source still has to change, in
// a section folded to its count, open first, closed folded away; nothing at all
// while the unit has none. The page reads them once (useChangeRequests) for the
// section and the attention line.
// Invented names.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ChangeRequestsPanel from './ChangeRequestsPanel';
import { useChangeRequests } from './useChangeRequests';
import { ClaimsContext } from '@ui/components/contexts/interviews/claimsContext';
import { closedLine, countLabel, raisedLine, splitRequests } from './changeRequests.helpers';
import { render as rtlRender } from '@testing-library/react';
import { renderWithProviders, makeAuthFetch, makeWrapper, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const OPEN = {
  id: 'r-1', status: 'open', summary: 'Remove Lotte Lindeboom from Harbour Office', targetName: 'HR export (upload)',
  raisedBy: 'analyst@example.test', raisedAt: '2026-10-23T09:15:00Z',
};
const RESOLVED = {
  id: 'r-2', status: 'resolved', summary: 'Remove Jan Smit from Harbour Office', targetName: 'HR export (upload)',
  raisedBy: 'unknown', raisedAt: '2026-10-01T08:00:00Z', closedAt: '2026-10-20T07:00:00Z', closedReason: 'The source no longer lists them',
};
const WITHDRAWN = { ...RESOLVED, id: 'r-3', status: 'withdrawn', summary: 'Remove Kai Kuiper from Harbour Office', closedReason: null };

describe('changeRequests.helpers', () => {
  it('splits open from closed, keeping the order', () => {
    expect(splitRequests([RESOLVED, OPEN, WITHDRAWN])).toEqual({ open: [OPEN], closed: [RESOLVED, WITHDRAWN] });
    expect(splitRequests()).toEqual({ open: [], closed: [] });
  });

  it('says where and by whom it was raised, leaving out an unknown caller', () => {
    expect(raisedLine(OPEN)).toBe('HR export (upload) · raised by analyst@example.test on 2026-10-23');
    expect(raisedLine(RESOLVED)).toBe('HR export (upload) · raised on 2026-10-01');
    expect(raisedLine({ ...OPEN, raisedBy: null })).toBe('HR export (upload) · raised on 2026-10-23');
  });

  it('says how and when it closed, with the reason when there is one', () => {
    expect(closedLine(RESOLVED)).toBe('Resolved 2026-10-20: The source no longer lists them');
    expect(closedLine(WITHDRAWN)).toBe('Withdrawn 2026-10-20');
    expect(closedLine({ status: 'other', closedAt: null })).toBe('other ');
  });

  it('counts open and closed, leaving out an empty side', () => {
    expect(countLabel({ open: [OPEN], closed: [] })).toBe('1 open');
    expect(countLabel({ open: [OPEN, OPEN, OPEN], closed: [RESOLVED, WITHDRAWN] })).toBe('3 open · 2 closed');
    expect(countLabel({ open: [], closed: [RESOLVED, WITHDRAWN] })).toBe('2 closed');
  });
});

// The section as the page wires it: the hook reads, the panel shows.
function Section({ enabled = true }) {
  const requests = useChangeRequests('c-unit', { enabled });
  return h(ChangeRequestsPanel, { id: 'cr', requests });
}

function render(items, seen = [], props = {}) {
  const authFetch = makeAuthFetch((url) => {
    seen.push(url);
    if (url === '/api/change-requests?contextId=c-unit') return jsonResponse({ items, counts: {} });
    return undefined;
  });
  return renderWithProviders(h(Section, props), { auth: { authFetch, ...READER } });
}

describe('ChangeRequestsPanel', () => {
  it('folds to its count; open, it lists the open requests with their source and folds the closed ones away', async () => {
    const seen = [];
    render([OPEN, RESOLVED, WITHDRAWN], seen);
    expect(await screen.findByTestId('change-requests-summary')).toHaveTextContent(/^1 open · 2 closed$/);
    expect(screen.queryByText('Remove Lotte Lindeboom from Harbour Office')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Change requests/ }));
    expect(screen.getByText('Remove Lotte Lindeboom from Harbour Office')).toBeTruthy();
    expect(screen.getByText('HR export (upload) · raised by analyst@example.test on 2026-10-23')).toBeTruthy();
    expect(screen.queryByText('Remove Jan Smit from Harbour Office')).toBeNull();
    expect(seen).toEqual(['/api/change-requests?contextId=c-unit']);

    await userEvent.click(screen.getByRole('button', { name: 'Show closed (2)' }));
    expect(screen.getByText('Remove Jan Smit from Harbour Office')).toBeTruthy();
    expect(screen.getByText('Resolved 2026-10-20: The source no longer lists them')).toBeTruthy();
    expect(screen.getByText('Withdrawn 2026-10-20')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Hide closed (2)' }));
    expect(screen.queryByText('Remove Jan Smit from Harbour Office')).toBeNull();
  });

  it('shows only the closed toggle when nothing is open', async () => {
    render([RESOLVED]);
    expect(await screen.findByTestId('change-requests-summary')).toHaveTextContent(/^1 closed$/);
    await userEvent.click(screen.getByRole('button', { name: /^Change requests/ }));
    expect(screen.getByRole('button', { name: 'Show closed (1)' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows nothing while the unit has no request, and reads nothing for a reader the page leaves it out for', async () => {
    const seen = [];
    const { container } = render([], seen);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(container.querySelector('section')).toBeNull();
    const none = [];
    render([OPEN], none, { enabled: false });
    await new Promise(r => setTimeout(r, 0));
    expect(none).toEqual([]);
  });
});

describe('useChangeRequests', () => {
  it('reads again when the unit\'s claims change (a decision), and not before', async () => {
    const seen = [];
    const authFetch = makeAuthFetch((url) => { seen.push(url); return jsonResponse({ items: [OPEN], counts: {} }); });
    const { wrapper: Wrapper } = makeWrapper({ auth: { authFetch, ...READER } });
    const page = (claims) => h(Wrapper, null, h(ClaimsContext.Provider, { value: { claims } }, h(Section)));
    const claims = [{ id: 'm-1' }];
    const { rerender } = rtlRender(page(claims));
    expect(await screen.findByTestId('change-requests-summary')).toHaveTextContent('1 open');
    expect(seen).toHaveLength(1);
    rerender(page(claims));
    expect(seen).toHaveLength(1);
    rerender(page([{ id: 'm-1', status: 'confirmed' }]));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual(['/api/change-requests?contextId=c-unit', '/api/change-requests?contextId=c-unit']);
  });
});
