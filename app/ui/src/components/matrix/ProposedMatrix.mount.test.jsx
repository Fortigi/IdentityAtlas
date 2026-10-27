// @vitest-environment jsdom
//
// The matrix's Proposed lens: the saved investigations to pick from, and what it
// hands the matrix — the proposals as "Draft: …" business-role bands next to the
// real ones, over the rows of the accounts they reach. The matrix itself is
// stubbed; what it is given is asserted.
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen, userEvent, waitFor, makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

const seen = vi.hoisted(() => ({ props: null }));
vi.mock('@ui/components/MatrixView', () => ({
  default: (props) => {
    seen.props = props;
    const bands = [...new Set(props.accessPackageGroups.map(g => g.accessPackageName))];
    return <ul data-testid="matrix">{bands.map(b => <li key={b}>{b}</li>)}<li>rows {props.data.length}</li></ul>;
  },
}));

import ProposedMatrix from './ProposedMatrix';

const ANN = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const LIST = [
  { id: 'inv-1', name: 'First pass', contextId: 'unit-1', unitName: 'Property Claims', updatedBy: 'ann', updatedAt: '2026-10-27T10:00:00' },
  { id: 'inv-2', name: 'Second pass', contextId: 'unit-1', unitName: 'Property Claims', updatedBy: 'bob', updatedAt: '2026-10-26T10:00:00' },
];
const INV = {
  'inv-1': { id: 'inv-1', name: 'First pass', contextId: 'unit-1', proposals: [{ id: 'p1', name: 'Handler', kind: 'requestable', members: ['i:ann'], entitlements: ['r1'] }] },
  'inv-2': { id: 'inv-2', name: 'Second pass', contextId: 'unit-1', proposals: [{ id: 'p2', name: 'Lead', kind: 'requestable', members: ['i:bob'], entitlements: ['r2'] }] },
};
const PEOPLE = [{ key: 'i:ann', direct: true, accounts: [{ id: ANN }] }, { key: 'i:bob', direct: true, accounts: [{ id: BOB }] }];
const REAL = [{ accessPackageId: 'br-1', accessPackageName: 'Claims Team', resourceId: 'r1', categoryName: 'Business' }];

function api({ list = LIST, matrix } = {}) {
  return makeAuthFetch((url, opts) => {
    if (url === '/api/workbench/investigations') return { data: list };
    const inv = url.match(/^\/api\/workbench\/investigations\/(.+)$/);
    if (inv) return INV[inv[1]];
    if (url.startsWith('/api/contexts/unit-1/workbench')) return { people: PEOPLE };
    if (url === '/api/workbench/proposals/matrix') {
      if (matrix) return matrix;
      const { principalIds } = JSON.parse(opts.body);
      return { data: principalIds.map(id => ({ memberId: id, resourceId: 'r1' })), managedByPackages: [{ memberId: ANN, resourceId: 'r1', accessPackageIds: ['br-1'] }] };
    }
    return undefined;
  });
}

function renderLens(authFetch) {
  renderWithProviders(
    <Suspense fallback={null}><ProposedMatrix accessPackageGroups={REAL} managedFilter="proposed" /></Suspense>,
    { auth: { authFetch } },
  );
  return authFetch;
}

describe('ProposedMatrix', () => {
  it('shows every saved investigation\'s proposals as Draft bands next to the real business roles', async () => {
    const authFetch = renderLens(api());
    const matrix = await screen.findByTestId('matrix');
    await waitFor(() => expect(matrix).toHaveTextContent('Draft: Lead'));
    expect(matrix).toHaveTextContent('Claims Team');
    expect(matrix).toHaveTextContent('Draft: Handler');
    expect(matrix).toHaveTextContent('rows 2');
    const post = authFetch.mock.calls.find(([u]) => u === '/api/workbench/proposals/matrix');
    expect(JSON.parse(post[1].body).principalIds.sort()).toEqual([ANN, BOB]);
    // The real role and the proposal both cover ann × r1.
    expect(seen.props.managedByPackages).toContainEqual({ memberId: ANN, resourceId: 'r1', groupId: 'r1', accessPackageIds: ['br-1', 'p1'] });
    expect(seen.props.showProposed).toBe(true);
  });

  it('narrows to one investigation from the picker', async () => {
    renderLens(api());
    const picker = await screen.findByLabelText('From investigation');
    expect([...picker.options].map(o => o.textContent)).toEqual([
      'All (2)', 'First pass (Property Claims, ann, 27-10-2026)', 'Second pass (Property Claims, bob, 26-10-2026)',
    ]);
    await userEvent.selectOptions(picker, 'inv-1');
    await waitFor(() => expect(screen.getByTestId('matrix')).not.toHaveTextContent('Draft: Lead'));
    expect(screen.getByTestId('matrix')).toHaveTextContent('Draft: Handler');
    expect(screen.getByTestId('matrix')).toHaveTextContent('rows 1');
  });

  it('says so when no investigation holds a proposed role', async () => {
    const authFetch = renderLens(api({ list: [] }));
    const authFetchCalls = () => authFetch.mock.calls.map(([u]) => u);
    expect(await screen.findByText('No workbench investigation with a proposed role is saved yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('matrix')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('From investigation')).not.toBeInTheDocument();
    expect(authFetchCalls()).not.toContain('/api/workbench/proposals/matrix');
  });

  it('shows the API\'s refusal', async () => {
    renderLens(api({ matrix: jsonResponse({ error: 'At most 2000 accounts.' }, { ok: false, status: 400 }) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 2000 accounts.');
  });

  it('shows a failed list', async () => {
    renderLens(makeAuthFetch({}));
    expect(await screen.findByRole('alert')).toHaveTextContent('not stubbed');
    expect(screen.queryByText(/No workbench investigation/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});
