// @vitest-environment jsdom
//
// Mount tests for the document half of the matrix strip (#768 → #1202): the name
// menu, "Unsaved changes" and "Shared with N".
//
// Inputs are chosen to discriminate. The SAME filter is rendered against a saved
// matrix it was and was not loaded from, and against one that is and is not
// shared, so a strip that hard-coded either state fails one of the pair. The
// "changed" matrix differs from the saved one in a real field (rowType), not in
// view state the fingerprint ignores.

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import MatrixNameBar from './MatrixNameBar';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
  resource: { include: [], exclude: [] },
};
const CHANGED = { ...FILTER, rowType: 'identity' };

const sharer = { permissions: new Set(['data.read', 'data.share']), hasWildcard: false, permissionsLoaded: true };
const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

const savedRow = (over = {}) => ({
  id: 'sf-1', name: 'HR users', filter: FILTER, shared: false, recipientCount: 0, ...over,
});
const everyone = savedRow({ id: 'sf-2', name: 'Everyone', filter: { ...FILTER, subject: { include: [], exclude: [] } } });

// The trail the History… verb opens. Two actors, so a dialog that showed the
// row's last writer for every event would fail.
const HISTORY = {
  id: 'sf-1', name: 'HR users', createdBy: 'wim@example.com', updatedBy: 'anna@example.com',
  events: [
    { at: '2026-09-20T10:00:00Z', actor: 'anna@example.com', operation: 'changed', changes: [{ field: 'name', label: 'Name', from: 'HR', to: 'HR users' }] },
    { at: '2026-03-01T10:00:00Z', actor: 'wim@example.com', operation: 'created', changes: [] },
  ],
};

// `saved` may be a function, so a test can change what the list returns after a
// rename or a duplicate and see the strip re-read it.
function render({ saved = [savedRow(), everyone], filter = { ...FILTER, savedFilterId: 'sf-1' }, onLoad, onAdjust, onShare, auth = sharer, put, post, del, history = HISTORY } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    const u = String(url);
    if (!u.includes('/api/matrix/saved-filters')) return undefined;
    if (u.endsWith('/history')) return history;
    if (opts?.method === 'PUT') return put ?? { id: 'sf-1', name: 'renamed' };
    if (opts?.method === 'POST') return post ?? { id: 'sf-new', name: 'copy' };
    if (opts?.method === 'DELETE') return del ?? jsonResponse({}, { status: 204 });
    return typeof saved === 'function' ? saved() : saved;
  });
  renderWithProviders(
    <MatrixNameBar filter={filter} onLoad={onLoad} onAdjust={onAdjust} onShare={onShare} />,
    { auth: { ...auth, authFetch }, features: { matrixSharing: true } },
  );
  return { authFetch, user: userEvent.setup() };
}

const calls = (authFetch, method) => authFetch.mock.calls.filter(([u, o]) => String(u).includes('saved-filters') && o?.method === method);
const listReads = (authFetch) => authFetch.mock.calls.filter(([u, o]) => u === '/api/matrix/saved-filters' && !o);

async function openMenu(user, name) {
  await user.click(await screen.findByRole('button', { name }));
  return screen.getByRole('list', { name: 'Saved matrices' });
}

describe('MatrixNameBar — the name on screen', () => {
  it('names the saved matrix the view was loaded from, with no unsaved-changes chip', async () => {
    render();
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('holds the name back while the list loads, instead of flashing "Unsaved matrix"', () => {
    const authFetch = vi.fn(() => new Promise(() => {}));
    renderWithProviders(<MatrixNameBar filter={FILTER} />, { auth: { authFetch } });
    expect(screen.getByRole('button', { name: 'Loading matrix…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved matrix' })).not.toBeInTheDocument();
  });

  it('calls a matrix that was never saved "Unsaved matrix" — and shows NO unsaved-changes chip', async () => {
    render({ filter: CHANGED });
    expect(await screen.findByRole('button', { name: 'Unsaved matrix' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('keeps the name of an adjusted saved matrix and offers its unsaved changes on the save step', async () => {
    const onAdjust = vi.fn();
    const { user } = render({ filter: { ...CHANGED, savedFilterId: 'sf-1' }, onAdjust });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unsaved changes' }));
    expect(onAdjust).toHaveBeenCalledTimes(1);
    expect(onAdjust).toHaveBeenCalledWith({ step: 'share' });
  });

  it('names an untagged view by what it matches, without calling it changed', async () => {
    render({ filter: FILTER });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('re-reads the list when the applied matrix changes, and only then', async () => {
    const authFetch = makeAuthFetch(() => [savedRow(), everyone]);
    function Harness() {
      const [filter, setFilter] = useState({ ...FILTER, savedFilterId: 'sf-1' });
      return (
        <>
          <button type="button" onClick={() => setFilter({ ...everyone.filter, savedFilterId: 'sf-2' })}>apply other</button>
          <MatrixNameBar filter={filter} />
        </>
      );
    }
    renderWithProviders(<Harness />, { auth: { authFetch } });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(listReads(authFetch)).toHaveLength(1);

    await userEvent.setup().click(screen.getByRole('button', { name: 'apply other' }));
    expect(await screen.findByRole('button', { name: 'Everyone' })).toBeInTheDocument();
    expect(listReads(authFetch)).toHaveLength(2);
  });

  // Sharing an unchanged saved matrix from the wizard applies an IDENTICAL
  // filter. The strip must still re-read the list, or it never shows the share;
  // a plain re-render (no apply) must not.
  it('re-reads after an apply of identical content, but not on a mere re-render', async () => {
    let shared = false;
    const authFetch = makeAuthFetch(() => [savedRow({ shared, recipientCount: shared ? 2 : 0 })]);
    function Harness() {
      const [filter, setFilter] = useState({ ...FILTER, savedFilterId: 'sf-1' });
      const [, rerender] = useState(0);
      return (
        <>
          <button type="button" onClick={() => { shared = true; setFilter(f => ({ ...f })); }}>apply same</button>
          <button type="button" onClick={() => rerender(n => n + 1)}>rerender</button>
          <MatrixNameBar filter={filter} onShare={() => {}} />
        </>
      );
    }
    renderWithProviders(<Harness />, { auth: { authFetch }, features: { matrixSharing: true } });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'rerender' }));
    expect(listReads(authFetch)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'apply same' }));
    expect(await screen.findByRole('button', { name: /Shared with 2 people/ })).toBeInTheDocument();
    expect(listReads(authFetch)).toHaveLength(2);
  });
});

describe('MatrixNameBar — the name menu', () => {
  it('lists every saved matrix, marks the current one and notes which are shared', async () => {
    const { user } = render({ saved: [savedRow(), savedRow({ id: 'sf-3', name: 'Sales', filter: CHANGED, shared: true, recipientCount: 1 })] });
    const list = await openMenu(user, 'HR users');

    const hr = within(list).getByRole('button', { name: /HR users/ });
    const sales = within(list).getByRole('button', { name: /Sales/ });
    expect(hr).toHaveAttribute('aria-current', 'true');
    expect(sales).not.toHaveAttribute('aria-current');
    expect(within(sales).getByText('Shared with 1 person')).toBeInTheDocument();
    expect(within(hr).queryByText(/Shared with/)).not.toBeInTheDocument();
  });

  it('loads a saved matrix tagged with its id, handing the governed toggle over separately', async () => {
    const onLoad = vi.fn();
    const { user } = render({
      saved: [savedRow(), savedRow({ id: 'sf-3', name: 'Sales', filter: { ...CHANGED, managed: 'managed' } })],
      onLoad,
    });
    const list = await openMenu(user, 'HR users');
    await user.click(within(list).getByRole('button', { name: /Sales/ }));

    expect(onLoad).toHaveBeenCalledWith({ ...CHANGED, savedFilterId: 'sf-3' }, 'managed');
    expect(screen.queryByRole('list', { name: 'Saved matrices' })).not.toBeInTheDocument();
  });

  it('starts a new matrix from an empty wizard', async () => {
    const onAdjust = vi.fn();
    const { user } = render({ onAdjust });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'New matrix…' }));
    expect(onAdjust).toHaveBeenCalledWith({ fresh: true });
  });

  it('offers Rename, Duplicate and Delete only when there is a saved matrix to act on', async () => {
    const { user } = render({ filter: CHANGED });
    await openMenu(user, 'Unsaved matrix');
    expect(screen.getByRole('button', { name: 'New matrix…' })).toBeInTheDocument();
    for (const verb of ['Rename…', 'Duplicate…', 'History…', 'Delete…']) {
      expect(screen.queryByRole('button', { name: verb })).not.toBeInTheDocument();
    }
  });

  it('opens the trail of the matrix on screen from History…', async () => {
    const { user } = render();
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'History…' }));
    // Titled after the matrix it was opened on, not the first row of the list.
    expect(await screen.findByText('History of “HR users”')).toBeInTheDocument();
    expect(await screen.findByText('anna@example.com changed it')).toBeInTheDocument();
    expect(screen.getByText('wim@example.com saved this matrix')).toBeInTheDocument();
  });

  it('marks the matrix whose context was deleted in the list, and only that one', async () => {
    const { user } = render({ saved: [savedRow({ missingContextIds: ['c-gone'] }), everyone] });
    const list = await openMenu(user, 'HR users');
    const [hr, all] = within(list).getAllByRole('listitem');
    expect(within(hr).getByLabelText(/Refers to 1 context that no longer exists/)).toHaveTextContent('broken');
    expect(within(all).queryByText('broken')).not.toBeInTheDocument();
  });

  it('closes on a click outside it', async () => {
    const { user } = render();
    await openMenu(user, 'HR users');
    await user.click(document.body);
    expect(screen.queryByRole('list', { name: 'Saved matrices' })).not.toBeInTheDocument();
  });
});

describe('MatrixNameBar — rename', () => {
  it('renames the current matrix with a PUT of its new name, and shows the new name', async () => {
    let name = 'HR users';
    const { authFetch, user } = render({ saved: () => [savedRow({ name }), everyone], put: undefined });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));

    const field = screen.getByRole('textbox', { name: 'Matrix name' });
    expect(field).toHaveValue('HR users');
    await user.clear(field);
    await user.type(field, 'People team');
    name = 'People team';
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(calls(authFetch, 'PUT')).toHaveLength(1));
    const [url, opts] = calls(authFetch, 'PUT')[0];
    expect(url).toBe('/api/matrix/saved-filters/sf-1');
    expect(JSON.parse(opts.body)).toEqual({ name: 'People team' });
    expect(await screen.findByRole('button', { name: 'People team' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Matrix name' })).not.toBeInTheDocument();
  });

  it('shows a taken name inline and keeps the dialog open', async () => {
    const { user } = render({ put: jsonResponse({ error: 'A filter with that name already exists' }, { ok: false, status: 409 }) });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    await user.type(screen.getByRole('textbox', { name: 'Matrix name' }), ' 2');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('A filter with that name already exists')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Matrix name' })).toHaveValue('HR users 2');
  });

  it('falls back to the HTTP status when the refusal carries no message', async () => {
    const { user } = render({ put: { ok: false, status: 500, json: async () => { throw new Error('not json'); } } });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Could not save this name (HTTP 500)')).toBeInTheDocument();
  });

  it('warns that recipients will see the new name of a shared matrix — and only then', async () => {
    const { user } = render({ saved: [savedRow({ shared: true, recipientCount: 2 })] });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    expect(screen.getByText('Shared with 2 people — they will see the new name.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Matrix name' })).not.toBeInTheDocument();
  });

  it('does not warn when renaming an unshared matrix', async () => {
    const { user } = render();
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Rename…' }));
    expect(screen.queryByText(/they will see the new name/)).not.toBeInTheDocument();
  });
});

describe('MatrixNameBar — duplicate', () => {
  it('offers "Copy of <name>" and stores the saved filter under the new name', async () => {
    const stored = { ...FILTER, managed: 'gaps' };
    const { authFetch, user } = render({ saved: [savedRow({ filter: stored })], filter: { ...FILTER, savedFilterId: 'sf-1' } });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Duplicate…' }));

    expect(screen.getByRole('textbox', { name: 'Matrix name' })).toHaveValue('Copy of HR users');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(calls(authFetch, 'POST')).toHaveLength(1));
    const [url, opts] = calls(authFetch, 'POST')[0];
    expect(url).toBe('/api/matrix/saved-filters');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Copy of HR users', filter: stored });
    expect(await screen.findByText('Matrix duplicated')).toBeInTheDocument();
    expect(calls(authFetch, 'PUT')).toHaveLength(0);
  });

  it('shows a name clash inline', async () => {
    const { user } = render({ post: jsonResponse({ error: 'A filter named "Copy of HR users" already exists' }, { ok: false, status: 409 }) });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Duplicate…' }));
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});

describe('MatrixNameBar — delete', () => {
  it('warns that deleting a shared matrix closes its recipients out, then deletes it', async () => {
    const { authFetch, user } = render({ saved: [savedRow({ shared: true, recipientCount: 2 })] });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));

    expect(await screen.findByText(/Shared with 2 people — deleting it stops their link working/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete matrix' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/saved-filters/sf-1', { method: 'DELETE' }));
  });

  it('gives an unshared matrix the org-wide warning instead', async () => {
    const { user } = render();
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText(/visible to everyone in the org, and deleting it affects them all/)).toBeInTheDocument();
    expect(screen.queryByText(/stops their link working/)).not.toBeInTheDocument();
  });

  it('does not delete when the warning is dismissed', async () => {
    const { authFetch, user } = render({ saved: [savedRow({ shared: true, recipientCount: 2 })] });
    await openMenu(user, 'HR users');
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(calls(authFetch, 'DELETE')).toHaveLength(0);
  });
});

describe('MatrixNameBar — twins with identical filters', () => {
  // A share made off "HR users" without changing it is a second saved matrix
  // with the same content. Listed first, so a strip matching on content alone
  // would name — and show the sharing of — the wrong one.
  const twins = [
    savedRow({ id: 'sf-share', name: 'Sales team', shared: true, recipientCount: 3 }),
    savedRow(),
  ];

  it('names the matrix the view was loaded from, not its twin, with its own (unshared) state', async () => {
    render({ saved: twins, filter: { ...FILTER, savedFilterId: 'sf-1' }, onShare: vi.fn() });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Shared with/ })).not.toBeInTheDocument();
  });

  it('shows the twin and its sharing when that is the one loaded', async () => {
    const onShare = vi.fn();
    const { user } = render({ saved: twins, filter: { ...FILTER, savedFilterId: 'sf-share' }, onShare });
    expect(await screen.findByRole('button', { name: 'Sales team' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Shared with 3 people/ }));
    expect(onShare).toHaveBeenCalledWith({ savedFilterId: 'sf-share', savedName: 'Sales team' });
  });
});

describe('MatrixNameBar — what is shared', () => {
  it('shows how many people a shared matrix reaches, and opens the panel on it — even with unsaved changes', async () => {
    const onShare = vi.fn();
    const { user } = render({ saved: [savedRow({ shared: true, recipientCount: 3 })], filter: { ...CHANGED, savedFilterId: 'sf-1' }, onShare });

    await user.click(await screen.findByRole('button', { name: /Shared with 3 people/ }));
    expect(onShare).toHaveBeenCalledWith({ savedFilterId: 'sf-1', savedName: 'HR users' });
    expect(screen.getByRole('button', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('offers no share control for an unshared matrix — creating a share is the wizard\'s last step', async () => {
    render({ onShare: vi.fn() });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Shared with|Share…/ })).not.toBeInTheDocument();
  });

  it('advertises no share control without the permission', async () => {
    render({ saved: [savedRow({ shared: true, recipientCount: 3 })], onShare: vi.fn(), auth: reader });
    expect(await screen.findByRole('button', { name: 'HR users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Shared with/ })).not.toBeInTheDocument();
  });
});
