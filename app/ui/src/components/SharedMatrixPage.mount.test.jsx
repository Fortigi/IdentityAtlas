// @vitest-environment jsdom
//
// Mount tests for the recipient's shared-matrix shell (#1166) — acceptance
// criteria 5, 7, 8, 10 and 11.
//
// The heavy matrix views are stubbed: what this file is responsible for is the
// SHELL — which snapshot reaches the matrix, what chrome the recipient does and
// does not get, the friendly terminal states, and the drill-down/back loop.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, act, userEvent } from '@ui/test-utils/renderWithProviders';

// Capture what the shell hands the matrix region instead of rendering the real
// (lazy, DnD-heavy) matrix.
const matrixProps = vi.fn();
vi.mock('@ui/components/app/AppMain', () => ({
  default: (props) => {
    if (props.isDetail) {
      return <div data-testid="detail-region">{props.detailRouteProps.page}</div>;
    }
    matrixProps(props.matrixProps);
    return <div data-testid="matrix-region">{props.loading ? 'loading' : 'matrix'}</div>;
  },
}));

// useMatrix would fire five unrelated fetches; the shell only cares that it is
// called with the snapshot's filter.
const useMatrixCalls = vi.fn();
vi.mock('@ui/hooks/useMatrix', () => ({
  useMatrix: (filter) => {
    useMatrixCalls(filter);
    return {
      data: [], rollup: null, counts: {}, accessPackageGroups: [], managedByPackages: [],
      resourceContexts: [], groupTagMap: null, loading: false, refreshing: false,
      hasData: true, error: null,
    };
  },
}));

const { default: SharedMatrixPage } = await import('./SharedMatrixPage');

const SNAPSHOT = {
  id: 'share-1',
  shareType: 'matrix',
  name: 'Sales team access',
  filter: { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } },
  displayMode: 'grid',
  managed: 'gaps',
};

function mount(resolveResult) {
  const authFetch = makeAuthFetch({ '/api/matrix/shares/resolve': resolveResult });
  return { authFetch, ...renderWithProviders(<SharedMatrixPage token="fgs_abc" />, { auth: { authFetch } }) };
}

beforeEach(() => { matrixProps.mockReset(); useMatrixCalls.mockReset(); });

describe('SharedMatrixPage — resolving the share', () => {
  it('resolves the token by POST and renders the snapshot name', async () => {
    const { authFetch } = mount(SNAPSHOT);
    expect(await screen.findByText('Sales team access')).toBeInTheDocument();

    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/matrix/shares/resolve');
    expect(opts.method).toBe('POST');            // token stays out of the URL
    expect(JSON.parse(opts.body)).toEqual({ token: 'fgs_abc' });
  });

  it('feeds the snapshot filter and managed toggle into the matrix (AC7)', async () => {
    mount(SNAPSHOT);
    await screen.findByText('Sales team access');
    await waitFor(() => expect(matrixProps.mock.calls.at(-1)[0].managedFilter).toBe('gaps'));

    const props = matrixProps.mock.calls.at(-1)[0];
    expect(props.matrixFilter).toEqual(SNAPSHOT.filter);
    expect(useMatrixCalls).toHaveBeenCalledWith(SNAPSHOT.filter);
  });

  it('rotates the view when the sharer was in the rotated layout (AC7, #1049)', async () => {
    mount({ ...SNAPSHOT, displayMode: 'rotated' });
    await screen.findByText('Sales team access');
    await waitFor(() =>
      expect(matrixProps.mock.calls.at(-1)[0].matrixFilter.orientation).toBe('rows-as-subjects'));
  });

  it('gives the recipient no analyst chrome (AC7)', async () => {
    mount(SNAPSHOT);
    await screen.findByText('Sales team access');
    // No nav, no dashboard link, no adjust/export affordance in the shell.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    for (const label of [/Dashboard/i, /Adjust matrix/i, /Export/i, /Sign out/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // …and nothing to navigate away with while the matrix is showing.
    expect(screen.queryByRole('button', { name: /Back to matrix/i })).not.toBeInTheDocument();
  });

  it('still renders an empty snapshot rather than an error (AC10)', async () => {
    // A filter that matches nothing resolves fine; the matrix renders its own
    // empty state, so the shell must not show the "no longer shared" page.
    mount({ ...SNAPSHOT, filter: { rowType: 'user', subject: { include: [] } } });
    expect(await screen.findByTestId('matrix-region')).toBeInTheDocument();
    expect(screen.queryByText(/no longer shared/i)).not.toBeInTheDocument();
  });
});

describe('SharedMatrixPage — terminal states (AC5)', () => {
  it('shows a friendly page for a revoked share, not an error dump', async () => {
    mount(jsonResponse({ error: 'This view is no longer shared' }, { ok: false, status: 410 }));
    expect(await screen.findByText(/This view is no longer shared/i)).toBeInTheDocument();
    expect(screen.queryByTestId('matrix-region')).not.toBeInTheDocument();
    expect(screen.queryByText(/410/)).not.toBeInTheDocument();
  });

  it('shows a different friendly page for an unknown token', async () => {
    mount(jsonResponse({ error: 'Share not found' }, { ok: false, status: 404 }));
    expect(await screen.findByText(/doesn.t open a shared view/i)).toBeInTheDocument();
    expect(screen.queryByText(/404/)).not.toBeInTheDocument();
  });

  it('tells somebody the link was forwarded to that it is not for them (#1166)', async () => {
    mount(jsonResponse({ error: 'This view was shared with specific people, and you are not one of them' }, { ok: false, status: 403 }));
    expect(await screen.findByText(/wasn.t shared with you/i)).toBeInTheDocument();
    // Distinct from the unknown-token page: the link is fine, the reader isn't
    // on the list, and telling them so is what lets them ask for access.
    expect(screen.queryByText(/doesn.t open a shared view/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('matrix-region')).not.toBeInTheDocument();
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
  });

  it('falls back to a generic message on a server error', async () => {
    mount(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    expect(await screen.findByText(/couldn.t be opened/i)).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});

describe('SharedMatrixPage — drill-down (AC8)', () => {
  it('opens a detail page inside the shell and comes back', async () => {
    mount(SNAPSHOT);
    await screen.findByText('Sales team access');

    // The matrix hands back the entity the recipient clicked.
    const { onOpenDetail } = matrixProps.mock.calls.at(-1)[0];
    await act(async () => onOpenDetail('group', 'grp-1', 'Finance Admins'));

    expect(await screen.findByTestId('detail-region')).toHaveTextContent('group:grp-1');
    // Detail navigation stays inside the shared shell.
    await userEvent.setup().click(screen.getByRole('button', { name: /Back to matrix/i }));
    expect(await screen.findByTestId('matrix-region')).toBeInTheDocument();
  });
});
