// @vitest-environment jsdom
//
// Mount tests for the Load / Save / Share bar (#768 + #1202).
//
// The three things the bar exists to make visible are asserted with inputs that
// discriminate: the SAME filter is rendered against a saved-matrix list that
// does and does not contain it, and against a saved matrix that is and is not
// shared, so a bar that hard-coded either state fails one of the pair.

import { describe, it, expect, vi } from 'vitest';
import MatrixSaveBar from './MatrixSaveBar';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
  resource: { include: [], exclude: [] },
};
const OTHER = { ...FILTER, rowType: 'identity' };

const sharer = { permissions: new Set(['data.read', 'data.share']), hasWildcard: false, permissionsLoaded: true };
const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

const savedRow = (over = {}) => ({
  id: 'sf-1', name: 'HR users', filter: FILTER, shared: false, recipientCount: 0, ...over,
});

function render({ saved = [savedRow()], filter = FILTER, onLoad, onShare, auth = sharer, post } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    const u = String(url);
    if (u.includes('/api/matrix/saved-filters') && opts?.method === 'POST') return post ?? { id: 'sf-new', name: 'New' };
    if (u.includes('/api/matrix/saved-filters')) return saved;
    return undefined;
  });
  renderWithProviders(
    <MatrixSaveBar filter={filter} managed="gaps" onLoad={onLoad} onShare={onShare} />,
    { auth: { ...auth, authFetch }, features: { matrixSharing: true } },
  );
  return { authFetch, user: userEvent.setup() };
}

describe('MatrixSaveBar — what is saved', () => {
  it('names the saved matrix the current view is', async () => {
    render();
    expect(await screen.findByText('HR users')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    // No Save action for something already saved.
    expect(screen.queryByRole('button', { name: 'Save matrix…' })).not.toBeInTheDocument();
  });

  // #768: the amber "Not saved" badge scolded. Same list, different filter.
  it('states an unsaved view neutrally and offers Save, with no warning wording', async () => {
    render({ filter: OTHER });
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save matrix…' })).toBeInTheDocument();
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument();
  });

  it('saves under a new name and folds the governed toggle into the matrix', async () => {
    const { authFetch, user } = render({ filter: OTHER });
    await user.click(await screen.findByRole('button', { name: 'Save matrix…' }));
    await user.type(screen.getByRole('textbox', { name: 'Matrix name' }), 'Identity view');
    await user.click(screen.getByRole('button', { name: 'Save as new matrix' }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters', expect.objectContaining({ method: 'POST' })));
    const [, opts] = authFetch.mock.calls.find(([u, o]) => String(u).includes('saved-filters') && o?.method === 'POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Identity view', filter: { ...OTHER, managed: 'gaps' } });
  });

  it('shows a taken name inline instead of overwriting anybody', async () => {
    const { user } = render({
      filter: OTHER,
      post: jsonResponse({ error: 'A filter named "HR users" already exists' }, { ok: false, status: 409 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Save matrix…' }));
    await user.type(screen.getByRole('textbox', { name: 'Matrix name' }), 'HR users');
    await user.click(screen.getByRole('button', { name: 'Save as new matrix' }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Matrix name' })).toBeInTheDocument();
  });
});

describe('MatrixSaveBar — loading', () => {
  it('applies the saved matrix and its governed toggle, separately from saving', async () => {
    const onLoad = vi.fn();
    const { user } = render({
      saved: [savedRow({ filter: { ...FILTER, managed: 'managed' } })],
      filter: OTHER,
      onLoad,
    });
    await user.click(await screen.findByRole('button', { name: /Load matrix \(1\)/ }));
    await user.click(await screen.findByRole('button', { name: 'HR users' }));

    // The filter is applied WITHOUT the stored toggle riding inside it — the
    // toggle is handed over separately, as the matrix's own state. It is tagged
    // with the saved matrix it came from.
    expect(onLoad).toHaveBeenCalledWith({ ...FILTER, savedFilterId: 'sf-1' }, 'managed');
  });

  it('warns that deleting a shared matrix closes its recipients out', async () => {
    const { authFetch, user } = render({ saved: [savedRow({ shared: true, recipientCount: 2 })] });
    await user.click(await screen.findByRole('button', { name: /Load matrix \(1\)/ }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/Shared with 2 people — deleting it stops their link working/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete matrix' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters/sf-1', { method: 'DELETE' }));
  });

  it('does not delete when the warning is dismissed', async () => {
    const { authFetch, user } = render({ saved: [savedRow({ shared: true, recipientCount: 2 })] });
    await user.click(await screen.findByRole('button', { name: /Load matrix \(1\)/ }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(authFetch).not.toHaveBeenCalledWith('/api/matrix/saved-filters/sf-1', { method: 'DELETE' });
  });
});

describe('MatrixSaveBar — twins with identical filters', () => {
  // A share made off "HR users" without changing it is a second saved matrix
  // with the same content. Listed first, so a bar matching on content alone
  // would name — and show the sharing of — the wrong one.
  const twins = [
    savedRow({ id: 'sf-share', name: 'Sales team', shared: true, recipientCount: 3 }),
    savedRow(),
  ];

  it('names the matrix the view was loaded from, not its twin', async () => {
    const onShare = vi.fn();
    const { user } = render({ saved: twins, filter: { ...FILTER, savedFilterId: 'sf-1' }, onShare });
    expect(await screen.findByText('HR users')).toBeInTheDocument();
    expect(screen.queryByText('Sales team')).not.toBeInTheDocument();
    // Its own (unshared) state, and Share acts on it — not on the twin.
    await user.click(await screen.findByRole('button', { name: 'Share…' }));
    expect(onShare).toHaveBeenCalledWith({ savedFilterId: 'sf-1', savedName: 'HR users' });
  });

  it('shows the twin and its sharing when that is the one loaded', async () => {
    render({ saved: twins, filter: { ...FILTER, savedFilterId: 'sf-share' }, onShare: vi.fn() });
    expect(await screen.findByText('Sales team')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Shared with 3 people/ })).toBeInTheDocument();
  });
});

describe('MatrixSaveBar — what is shared', () => {
  it('shows how many people a shared matrix reaches, and opens the panel on it', async () => {
    const onShare = vi.fn();
    const { user } = render({ saved: [savedRow({ shared: true, recipientCount: 3 })], onShare });

    const chip = await screen.findByRole('button', { name: /Shared with 3 people/ });
    await user.click(chip);
    expect(onShare).toHaveBeenCalledWith({ savedFilterId: 'sf-1', savedName: 'HR users' });
  });

  it('offers to share an unsaved matrix too — one act, no saved matrix yet', async () => {
    const onShare = vi.fn();
    const { user } = render({ filter: OTHER, onShare });

    await user.click(await screen.findByRole('button', { name: 'Share…' }));
    expect(onShare).toHaveBeenCalledWith({ savedFilterId: null, savedName: null });
  });

  it('advertises no share control without the permission', async () => {
    render({ saved: [savedRow({ shared: true, recipientCount: 3 })], onShare: vi.fn(), auth: reader });
    expect(await screen.findByText('HR users')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Shared with/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share…' })).not.toBeInTheDocument();
  });
});
