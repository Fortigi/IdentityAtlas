// @vitest-environment jsdom
//
// Mount tests for the Matrix wizard's Save & share step (#1202): ONE primary
// button whose label and effect follow the fields — show, save & show, save
// changes & show, save as a copy — with sharing applied as part of that same
// click, and the applied matrix tagged with the saved matrix it now is.
//
// Inputs discriminate: the edited matrix is SHARED in the fixture that checks
// the PUT, so a flow that skipped the live-share warning fails; the copy test
// types the original's exact name, so a copy that silently overwrote fails.

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent, jsonResponse } from '@ui/test-utils/renderWithProviders';
import {
  makeWizardFetch, renderWizard, gotoStep, pickPerson, bodiesSent, HR_FILTER, ANN_RECIPIENT,
} from '@ui/test-utils/matrixWizardFixtures';

const SAVED_URL = '/api/matrix/saved-filters';
const primary = (name) => screen.getByRole('button', { name });
const nameField = () => screen.getByRole('textbox', { name: 'Name' });

async function openSaveStep(props = {}, fetch = makeWizardFetch(), options) {
  const r = renderWizard(props, fetch, options);
  await screen.findByText('120'); // preview landed, so the size rules are settled
  await gotoStep(r.user, 'Save & share');
  return r;
}

describe('MatrixFilterWizard — Save & share', () => {
  it('opens a fresh matrix (null initialFilter) as a new, unnamed one', async () => {
    const { user } = await openSaveStep({ initialFilter: null, initialManaged: 'all' }, makeWizardFetch({ saved: [] }));
    expect(screen.getByText('Create matrix')).toBeInTheDocument();
    expect(nameField()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Save as a copy instead' })).not.toBeInTheDocument();
    expect(primary('Show matrix')).toBeEnabled();
    await gotoStep(user, 'Subjects');
    expect(screen.getByRole('button', { name: /^User accounts/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the matrix without saving when the name is left empty', async () => {
    const { user, onApply, authFetch } = await openSaveStep({ initialManaged: 'unmanaged' });
    expect(nameField()).toHaveValue('');
    expect(screen.getByText(/Leave empty to show it without saving/)).toBeInTheDocument();
    await user.click(primary('Show matrix'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).not.toHaveProperty('savedFilterId');
    expect(onApply.mock.calls[0][1]).toBe('unmanaged');
    expect(bodiesSent(authFetch, SAVED_URL, 'POST')).toEqual([]);
  });

  it('saves a named matrix with its description and lens, then shows it tagged with the new id', async () => {
    const { user, onApply, authFetch } = await openSaveStep({ initialManaged: 'gaps' });
    await user.type(nameField(), '  Sales access ');
    expect(primary('Save & show')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Add a description/ }));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Who in Sales holds what');
    await user.click(primary('Save & show'));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [body] = bodiesSent(authFetch, SAVED_URL, 'POST');
    expect(body.name).toBe('Sales access');
    expect(body.description).toBe('Who in Sales holds what');
    expect(body.filter).toMatchObject({ rowType: 'principal', managed: 'gaps', foldAttributes: false });
    const [appliedFilter, managed] = onApply.mock.calls[0];
    expect(appliedFilter.savedFilterId).toBe('sf-new');
    expect(appliedFilter).not.toHaveProperty('managed');
    expect(managed).toBe('gaps');
  });

  it('shows a taken name inline on the name field and stays on the step', async () => {
    const fetch = makeWizardFetch({ post: jsonResponse({ error: 'A filter named "Sales access" already exists' }, { ok: false, status: 409 }) });
    const { user, onApply } = await openSaveStep({}, fetch);
    await user.type(nameField(), 'Sales access');
    await user.click(primary('Save & show'));

    expect(await screen.findByRole('alert')).toHaveTextContent('A filter named "Sales access" already exists');
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    expect(onApply).not.toHaveBeenCalled();
    // Typing a new name clears the complaint.
    await user.type(nameField(), ' 2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows any other refusal as a general error, not on the name', async () => {
    const fetch = makeWizardFetch({ post: { ok: false, status: 500, json: async () => { throw new Error('not json'); } } });
    const { user, onApply } = await openSaveStep({}, fetch);
    await user.type(nameField(), 'Sales access');
    await user.click(primary('Save & show'));
    expect(await screen.findByText('Could not save the matrix (HTTP 500)')).toBeInTheDocument();
    expect(nameField()).toHaveAttribute('aria-invalid', 'false');
    expect(onApply).not.toHaveBeenCalled();
  });

  describe('sharing as part of the same click', () => {
    it('asks for a name when people are picked without one, sending nothing', async () => {
      const { user, onApply, authFetch } = await openSaveStep();
      // A matrix nobody has yet gets the one-line introduction to sharing.
      expect(screen.getByText(/Send it to colleagues who have no Identity Atlas role/)).toBeInTheDocument();
      await pickPerson(user, 'Ann Manager');
      expect(primary('Save & show')).toBeEnabled();
      await user.click(primary('Save & show'));
      expect(screen.getByRole('alert')).toHaveTextContent('Name this matrix to share it');
      expect(authFetch.mock.calls.some(([, o]) => o?.method === 'POST' && o.body?.includes('"name"'))).toBe(false);
      expect(onApply).not.toHaveBeenCalled();
    });

    it('saves first, then shares the saved matrix by id, then shows it', async () => {
      const { user, onApply, authFetch } = await openSaveStep();
      await user.type(nameField(), 'Sales access');
      await pickPerson(user, 'Ann Manager');
      // No second "Share" button inside the step — the primary button does it.
      expect(screen.queryByRole('button', { name: /^Share matrix$|^Save & share$/ })).not.toBeInTheDocument();
      await user.click(primary('Save & show'));

      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      const posts = authFetch.mock.calls.filter(([, o]) => o?.method === 'POST' && o.body).map(([u]) => u);
      expect(posts.filter(u => u !== '/api/matrix/preview')).toEqual([SAVED_URL, '/api/matrix/shares']);
      expect(bodiesSent(authFetch, '/api/matrix/shares', 'POST')).toEqual([{ savedFilterId: 'sf-new', recipients: [ANN_RECIPIENT] }]);
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-new');
      expect(await screen.findByText(/saved\. Shared with 1 person\./)).toBeInTheDocument();
    });

    it('keeps the saved matrix when the share fails, and a retry only shares', async () => {
      let shareAttempts = 0;
      const base = makeWizardFetch();
      const authFetch = vi.fn(async (url, opts = {}) => {
        if (url === '/api/matrix/shares' && opts.method === 'POST' && shareAttempts++ === 0) {
          return jsonResponse({ error: 'Directory unavailable' }, { ok: false, status: 503 });
        }
        return base(url, opts);
      });
      const { user, onApply } = await openSaveStep({}, authFetch);
      await user.type(nameField(), 'Sales access');
      await pickPerson(user, 'Ann Manager');
      await user.click(primary('Save & show'));

      expect(await screen.findByText('Directory unavailable')).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
      // The matrix exists now: the button no longer creates a second one.
      await user.click(await screen.findByRole('button', { name: 'Share & show' }));
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      expect(bodiesSent(authFetch, SAVED_URL, 'POST')).toHaveLength(1);
      expect(bodiesSent(authFetch, '/api/matrix/shares', 'POST')).toHaveLength(2);
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-new');
    });

    it('offers no share section to a user who may not share — saving still works', async () => {
      const { user, onApply } = await openSaveStep({}, makeWizardFetch(), { features: { matrixSharing: false } });
      expect(screen.queryByRole('textbox', { name: /^Share with/ })).not.toBeInTheDocument();
      await user.type(nameField(), 'Mine');
      await user.click(primary('Save & show'));
      await waitFor(() => expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-new'));
    });
  });

  describe('adjusting a saved matrix', () => {
    const SHARED = { id: 'sf-1', name: 'HR users', description: 'HR only', filter: HR_FILTER, shared: true, recipientCount: 2 };
    const LIVE_SHARE = {
      id: 'sh-1', name: 'HR users', savedFilterId: 'sf-1', revokedAt: null,
      recipients: [ANN_RECIPIENT, { userKey: 'bob@contoso.com', displayName: 'Bob' }],
    };
    const editFetch = (extra = {}) => makeWizardFetch({ saved: [SHARED], shares: [LIVE_SHARE], ...extra });

    async function divergeFromSaved(user) {
      await gotoStep(user, 'Subjects');
      await user.click(screen.getAllByText('+ Attribute')[0]);
      fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'jobTitle' } });
      await user.click(await screen.findByRole('checkbox', { name: /Manager/i }));
      await user.click(screen.getByText('Add'));
      await gotoStep(user, 'Save & share');
    }

    it('prefills the name and description, and just shows it when nothing changed', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      expect(screen.getByRole('button', { name: /Add a description/ })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('HR only');
      // A shared matrix shows who it is shared with, managed in place.
      expect(await screen.findByRole('button', { name: 'Stop sharing' })).toBeInTheDocument();
      expect(screen.queryByText(/they will see this change/)).not.toBeInTheDocument();
      // The recipients editor already says who has it; no second introduction.
      expect(screen.queryByText(/Send it to colleagues who have no Identity Atlas role/)).not.toBeInTheDocument();

      await user.click(primary('Show matrix'));
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-1');
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
    });

    it('shows a changed matrix unsaved when the name is emptied, still tagged with the matrix it came from', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);
      expect(primary('Save changes & show')).toBeInTheDocument();
      await user.clear(nameField());
      await user.click(primary('Show matrix'));
      const [appliedFilter] = onApply.mock.calls[0];
      expect(appliedFilter.savedFilterId).toBe('sf-1');
      expect(appliedFilter.subject.include.map(c => c.field)).toEqual(['department', 'jobTitle']);
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
    });

    // Emptying the name and typing another must never rename — and so overwrite —
    // the matrix that was opened (the org default, in the e2e that caught this).
    it('treats a name typed after emptying it as a NEW matrix, leaving the original untouched', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);

      await user.clear(nameField());
      expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
      await user.type(nameField(), 'HR managers');
      expect(primary('Save & show')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save changes & show' })).not.toBeInTheDocument();

      await user.click(primary('Save & show'));
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      const [post] = bodiesSent(authFetch, SAVED_URL, 'POST');
      expect(post.name).toBe('HR managers');
      expect(post.description).toBeNull();
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-new');
    });

    it('refuses the original name after emptying it, rather than clashing or overwriting', async () => {
      const { user, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);
      await user.clear(nameField());
      await user.type(nameField(), 'HR users');
      await user.click(primary('Save & show'));
      expect(screen.getByRole('alert')).toHaveTextContent('Give the copy a different name');
      expect(bodiesSent(authFetch, SAVED_URL, 'POST')).toEqual([]);
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
    });

    it('saves changes back with a PUT, warning that its recipients will see them', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER, initialManaged: 'managed' }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);

      expect(screen.getByText('Shared with 2 people — they will see this change.')).toBeInTheDocument();
      await user.click(primary('Save changes & show'));

      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      const [put] = bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT');
      expect(put.name).toBe('HR users');
      expect(put.description).toBe('HR only');
      expect(put.filter.subject.include.map(c => c.field)).toEqual(['department', 'jobTitle']);
      expect(put.filter.managed).toBe('managed');
      expect(bodiesSent(authFetch, SAVED_URL, 'POST')).toEqual([]);
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-1');
    });

    it('counts a changed lens as a change to save', async () => {
      const { user } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(primary('Show matrix')).toBeInTheDocument());
      await gotoStep(user, 'Layout');
      await user.click(screen.getByRole('button', { name: 'Gaps' }));
      await gotoStep(user, 'Save & share');
      expect(primary('Save changes & show')).toBeInTheDocument();
    });

    it('shows a refused update and keeps the wizard open', async () => {
      const fetch = editFetch({ put: jsonResponse({ error: 'Filter not found' }, { ok: false, status: 404 }) });
      const { user, onApply } = await openSaveStep({ initialFilter: HR_FILTER }, fetch);
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);
      await user.click(primary('Save changes & show'));
      expect(await screen.findByText('Filter not found')).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });

    it('saves as a copy under a different name, with a POST and nothing written to the original', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);

      await user.click(screen.getByRole('button', { name: 'Save as a copy instead' }));
      expect(nameField()).toHaveValue('HR users (copy)');
      // A copy is not shared — the people field replaces the recipients editor,
      // and the live-share warning goes with it.
      expect(screen.getByRole('textbox', { name: /^Share with/ })).toBeInTheDocument();
      expect(screen.queryByText(/they will see this change/)).not.toBeInTheDocument();

      await user.clear(nameField());
      await user.type(nameField(), 'HR users');
      await user.click(primary('Save & show'));
      expect(screen.getByRole('alert')).toHaveTextContent('Give the copy a different name');
      expect(bodiesSent(authFetch, SAVED_URL, 'POST')).toEqual([]);

      await user.type(nameField(), ' — managers');
      await user.click(primary('Save & show'));
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      expect(bodiesSent(authFetch, SAVED_URL, 'POST')[0].name).toBe('HR users — managers');
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
      expect(onApply.mock.calls[0][0].savedFilterId).toBe('sf-new');
    });

    it('can go back from a copy to saving the original', async () => {
      const { user } = await openSaveStep({ initialFilter: HR_FILTER }, editFetch());
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await divergeFromSaved(user);
      await user.click(screen.getByRole('button', { name: 'Save as a copy instead' }));
      await user.click(screen.getByRole('button', { name: 'Save changes to the original instead' }));
      expect(nameField()).toHaveValue('HR users');
      expect(primary('Save changes & show')).toBeInTheDocument();
    });

    it('shares an unchanged, unshared saved matrix without saving it again', async () => {
      const unshared = { ...SHARED, shared: false, recipientCount: 0 };
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: HR_FILTER }, makeWizardFetch({ saved: [unshared] }));
      await waitFor(() => expect(nameField()).toHaveValue('HR users'));
      await pickPerson(user, 'Ann Manager');
      await user.click(primary('Share & show'));
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      expect(bodiesSent(authFetch, `${SAVED_URL}/sf-1`, 'PUT')).toEqual([]);
      expect(bodiesSent(authFetch, '/api/matrix/shares', 'POST')).toEqual([{ savedFilterId: 'sf-1', recipients: [ANN_RECIPIENT] }]);
    });
  });

  describe('tagging a shown matrix when two saved matrices share a filter', () => {
    const twins = [
      { id: 'sf-share', name: 'Sales team', filter: HR_FILTER, shared: true, recipientCount: 1 },
      { id: 'sf-1', name: 'HR users', filter: HR_FILTER },
    ];

    async function showOpenedOn(initialFilter) {
      const { user, onApply } = await openSaveStep({ initialFilter }, makeWizardFetch({ saved: twins }));
      await user.click(await screen.findByRole('button', { name: 'Show matrix' }));
      return onApply.mock.calls[0][0];
    }

    it('tags the matrix it was opened on, not its twin', async () => {
      expect((await showOpenedOn({ ...HR_FILTER, savedFilterId: 'sf-1' })).savedFilterId).toBe('sf-1');
    });

    it('tags an untagged matrix with its first content match', async () => {
      expect((await showOpenedOn(HR_FILTER)).savedFilterId).toBe('sf-share');
    });

    it('keeps the tag of the matrix it was opened on when the content has moved on', async () => {
      // The strip reads a tag that no longer matches the content as "Unsaved
      // changes" — dropping it would make an adjusted matrix forget its name.
      expect((await showOpenedOn({ ...HR_FILTER, rowType: 'identity', savedFilterId: 'sf-1' })).savedFilterId).toBe('sf-1');
    });

    it('shows a never-saved matrix without a tag', async () => {
      expect(await showOpenedOn({ ...HR_FILTER, rowType: 'identity' })).not.toHaveProperty('savedFilterId');
    });
  });

  describe('a matrix too large to load', () => {
    const OVERSIZED = {
      rowType: 'principal',
      sortAttributes: [{ attribute: 'department', dir: 'asc' }],
      foldOnLoad: true,
      rollupExpanded: ['Engineering'],
    };
    const big = () => makeWizardFetch({ saved: [], preview: { assignmentCount: 99999 } });

    it('blocks the primary button and offers nothing to share when it cannot fold', async () => {
      const { user, onApply } = await openSaveStep({ initialFilter: { ...OVERSIZED, sortAttributes: [], foldOnLoad: false } }, big());
      const count = (99999).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(await screen.findByText(new RegExp(count))).toBeInTheDocument();
      await waitFor(() => expect(primary('Show matrix')).toBeDisabled());
      expect(screen.getByText(/too large to load, so there is nothing to share/i)).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: /^Share with/ })).not.toBeInTheDocument();
      await user.click(primary('Show matrix'));
      expect(onApply).not.toHaveBeenCalled();
    });

    it('saves the shape that will load — folded and at the top level — not the raw edit state', async () => {
      const { user, onApply, authFetch } = await openSaveStep({ initialFilter: OVERSIZED }, big());
      await screen.findByText(/aggregated on the server/);
      await user.type(nameField(), 'Engineering access');
      await user.click(primary('Save & show'));
      await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
      const [body] = bodiesSent(authFetch, SAVED_URL, 'POST');
      expect(body.filter.foldAttributes).toBe(true);
      expect(body.filter.rollupExpanded).toEqual([]);
      expect(body.filter.rollupCollapsed).toEqual([]);
      expect(onApply.mock.calls[0][0].foldAttributes).toBe(true);
    });
  });
});
