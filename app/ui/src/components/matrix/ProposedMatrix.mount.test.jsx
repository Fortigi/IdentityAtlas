// @vitest-environment jsdom
//
// The matrix with "+ Proposed roles" on: the saved investigations to pick from,
// and what it hands the matrix — the view it already had (the same rows, the same
// lens, the same real coverage for the lens filters) plus the proposals as
// "Draft: …" bands and their cells to colour. The matrix itself is stubbed; what
// it is given is asserted.
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen, userEvent, waitFor, makeAuthFetch } from '@ui/test-utils/renderWithProviders';

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
const DATA = [{ memberId: ANN, resourceId: 'r1' }, { memberId: BOB, resourceId: 'r9' }, { memberId: 'x', resourceId: 'r9' }];
const COVERED = [{ memberId: ANN, resourceId: 'r1', accessPackageIds: ['br-1'] }];

function api({ list = LIST, workbench } = {}) {
  return makeAuthFetch((url) => {
    if (url === '/api/workbench/investigations') return { data: list };
    const inv = url.match(/^\/api\/workbench\/investigations\/(.+)$/);
    if (inv) return INV[inv[1]];
    if (url.startsWith('/api/contexts/unit-1/workbench')) return workbench ?? { people: PEOPLE };
    return undefined;
  });
}

function renderLens(authFetch) {
  renderWithProviders(
    <Suspense fallback={null}>
      <ProposedMatrix data={DATA} accessPackageGroups={REAL} managedByPackages={COVERED} managedFilter="managed" />
    </Suspense>,
    { auth: { authFetch } },
  );
  return authFetch;
}

describe('ProposedMatrix', () => {
  it('keeps the view — its rows, its lens and the real coverage — and adds every saved proposal as a Draft band', async () => {
    const authFetch = renderLens(api());
    const matrix = await screen.findByTestId('matrix');
    await waitFor(() => expect(matrix).toHaveTextContent('Draft: Lead'));
    expect(matrix).toHaveTextContent('Claims Team');
    expect(matrix).toHaveTextContent('Draft: Handler');
    expect(matrix).toHaveTextContent('rows 3');
    expect(seen.props).toMatchObject({ managedFilter: 'managed', managedByPackages: COVERED, showProposed: true, proposedOn: true });
    // Only the proposals' cells go to colouring; the real coverage stays the lens filters' alone.
    expect(seen.props.extraCoverage).toEqual([
      { memberId: ANN, resourceId: 'r1', groupId: 'r1', accessPackageIds: ['p1'] },
      { memberId: BOB, resourceId: 'r2', groupId: 'r2', accessPackageIds: ['p2'] },
    ]);
    // It reads no matrix rows of its own.
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/workbench/proposals/matrix');
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
  });

  it('says so when no investigation holds a proposed role, and still shows the view', async () => {
    const authFetch = renderLens(api({ list: [] }));
    expect(await screen.findByText('No workbench investigation with a proposed role is saved yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('From investigation')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('matrix')).toHaveTextContent('rows 3'));
    expect(seen.props.extraCoverage).toEqual([]);
    expect(authFetch.mock.calls.map(c => c[0])).toEqual(['/api/workbench/investigations']);
  });

  it('shows why the proposals could not be read, over the view as it was', async () => {
    renderLens(makeAuthFetch({}));
    expect(await screen.findByRole('alert')).toHaveTextContent('not stubbed');
    expect(screen.getByTestId('matrix')).toHaveTextContent('Claims Team');
    expect(screen.getByTestId('matrix')).not.toHaveTextContent('Draft:');
  });
});
