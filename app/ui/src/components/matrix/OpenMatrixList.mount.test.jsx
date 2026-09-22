// @vitest-environment jsdom
//
// The matrix tab with nothing on screen: "Open a matrix" (#1202).
import { describe, it, expect, vi, afterEach } from 'vitest';
import OpenMatrixList from './OpenMatrixList';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'principal', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } };
const NOW = new Date('2026-09-14T12:00:00Z');

const rows = [
  { id: 'sf-1', name: 'Everyone', filter: { ...FILTER, managed: 'gaps' }, isDefault: true, shared: false, recipientCount: 0, updatedAt: '2026-09-11T12:00:00Z', missingContextIds: [] },
  // Attributed and unattributed side by side: a list that hard-coded either
  // spelling of the last-changed label fails one of the two.
  { id: 'sf-2', name: 'HR users', filter: { ...FILTER, rowType: 'identity' }, isDefault: false, shared: true, recipientCount: 3, updatedAt: '2026-09-14T09:00:00Z', updatedBy: 'anna@example.com', missingContextIds: ['c-gone'] },
];

function render({ saved = rows, hasData = true, sharedView = false, authFetch } = {}) {
  const onLoad = vi.fn();
  const onNew = vi.fn();
  const fetcher = authFetch || makeAuthFetch((url) => (String(url).includes('/api/matrix/saved-filters') ? saved : undefined));
  const ui = <OpenMatrixList hasData={hasData} onLoad={onLoad} onNew={onNew} />;
  const result = renderWithProviders(
    sharedView ? <SharedViewContext.Provider value={true}>{ui}</SharedViewContext.Provider> : ui,
    { auth: { authFetch: fetcher } },
  );
  return { ...result, onLoad, onNew, authFetch: fetcher, user: userEvent.setup() };
}

afterEach(() => vi.useRealTimers());

describe('OpenMatrixList', () => {
  it('lists every saved matrix with its org-default marker, sharing and last change', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    render();
    const list = await screen.findByRole('list', { name: 'Saved matrices' });
    const [everyone, hr] = within(list).getAllByRole('button');

    expect(everyone).toHaveTextContent('Everyone');
    expect(within(everyone).getByText('org default')).toBeInTheDocument();
    expect(within(everyone).queryByText(/Shared with/)).not.toBeInTheDocument();
    // No updatedBy on this row (saved before the trail existed): the label
    // names the time and stops, rather than inventing an author.
    expect(within(everyone).getByText('Changed 3d ago')).toBeInTheDocument();

    expect(hr).toHaveTextContent('HR users');
    expect(within(hr).queryByText('org default')).not.toBeInTheDocument();
    expect(within(hr).getByText('Shared with 3 people')).toBeInTheDocument();
    expect(within(hr).getByText('Changed 3h ago by anna@example.com')).toBeInTheDocument();
  });

  it('opens a saved matrix tagged with its id, with its governed toggle handed over separately', async () => {
    const { onLoad, user } = render();
    await user.click(await screen.findByRole('button', { name: /Everyone/ }));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith({ ...FILTER, savedFilterId: 'sf-1' }, 'gaps');
  });

  it('starts a new matrix', async () => {
    const { onNew, onLoad, user } = render();
    await user.click(screen.getByRole('button', { name: 'New matrix' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('explains what a matrix is when nobody has saved one, and still offers New matrix', async () => {
    render({ saved: [] });
    expect(await screen.findByText(/Nobody has saved a matrix yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Saved matrices' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New matrix' })).toBeInTheDocument();
  });

  it('says it is loading until the list arrives', () => {
    render({ authFetch: vi.fn(() => new Promise(() => {})) });
    expect(screen.getByText('Loading saved matrices…')).toBeInTheDocument();
    expect(screen.queryByText(/Nobody has saved a matrix yet/)).not.toBeInTheDocument();
  });

  it('treats an unreadable list as empty rather than failing', async () => {
    render({ authFetch: makeAuthFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 500 })) });
    expect(await screen.findByText(/Nobody has saved a matrix yet/)).toBeInTheDocument();
  });

  it('keeps the "no data" message when the database is empty, without a list', () => {
    const { authFetch } = render({ hasData: false });
    expect(screen.getByText('No data available yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New matrix' })).not.toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('renders nothing while it is not yet known whether there is data', () => {
    const { container, authFetch } = render({ hasData: null });
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows a share recipient nothing, and does not fetch the org\'s saved matrices', () => {
    const { container, authFetch } = render({ sharedView: true });
    expect(container).toBeEmptyDOMElement();
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe('OpenMatrixList — matrices that no longer work', () => {
  it('marks only the matrix whose context was deleted, and says why', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Saved matrices' });
    const [everyone, hr] = within(list).getAllByRole('button');

    expect(within(hr).getByLabelText(/Refers to 1 context that no longer exists/)).toHaveTextContent('broken');
    // The healthy matrix carries no marker — a badge on everything says nothing.
    expect(within(everyone).queryByText('broken')).not.toBeInTheDocument();
  });
});
