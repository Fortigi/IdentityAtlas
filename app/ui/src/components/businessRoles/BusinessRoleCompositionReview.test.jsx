// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import BusinessRoleCompositionReview from './BusinessRoleCompositionReview';
import { changeText } from './accessModel';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const URL = '/api/access-package/br-1/composition-reviews';
const SIGNED = {
  id: 'r1', signedOff: true, notes: 'All three groups belong here.', reviewedBy: 'ann@example.test', reviewedByName: 'Ann Analyst',
  reviewedAt: '2026-11-20T10:00:00Z', composition: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }],
  changesSince: { added: ['SG-HR'], removed: [] },
};
const NOTE = { id: 'r2', signedOff: false, notes: 'Why is SG-HR in here?', reviewedBy: 'bob@example.test', reviewedAt: '2026-11-22T09:00:00Z', composition: [] };

function api({ summary = { reviews: [NOTE, SIGNED], current: 4, latestSignOff: SIGNED }, failPost = false, failGet = false } = {}) {
  const state = { posts: [], summary };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (String(url) !== URL) return undefined;
    if (opts.method === 'POST') {
      if (failPost) return jsonResponse({ error: 'Write a note or sign off' }, { ok: false, status: 400 });
      const body = JSON.parse(opts.body);
      state.posts.push(body);
      const saved = { id: `r${state.posts.length + 2}`, ...body, reviewedBy: 'me@example.test', reviewedAt: '2026-11-24T12:00:00Z', composition: [] };
      state.summary = { ...state.summary, reviews: [saved, ...state.summary.reviews] };
      return jsonResponse(saved, { status: 201 });
    }
    if (failGet) return jsonResponse({ error: 'down' }, { ok: false, status: 500 });
    return state.summary;
  });
  return { authFetch, state };
}

const SIGNER = { hasWildcard: false, permissions: new Set(['data.write.certifications']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function mount({ auth = SIGNER, shared = false, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  const onOpenTab = vi.fn();
  const el = h(BusinessRoleCompositionReview, { roleId: 'br-1', onOpenTab });
  renderWithProviders(shared ? h(SharedViewContext.Provider, { value: true }, el) : el, { auth: { authFetch, ...auth } });
  return { state, onOpenTab, user: userEvent.setup() };
}

describe('changeText', () => {
  it('names what was added and removed since the sign-off', () => {
    expect(changeText({ added: ['A', 'B'], removed: ['C'] })).toBe('Since then: added A, B; removed C.');
    expect(changeText({ added: [], removed: ['C'] })).toBe('Since then: removed C.');
    expect(changeText({ added: [], removed: [] })).toBeNull();
    expect(changeText()).toBeNull();
  });
});

describe('BusinessRoleCompositionReview', () => {
  it('says who signed off, when, what it held then, and what changed since', async () => {
    const { onOpenTab, user } = mount();
    const status = await screen.findByTestId('sign-off-status');
    expect(status).toHaveTextContent('Signed off by Ann Analyst');
    expect(status).toHaveTextContent('when it contained 3 resources');
    expect(status).toHaveTextContent('It contains 4 resources now.');
    expect(within(status).getByRole('alert')).toHaveTextContent('Since then: added SG-HR.');
    await user.click(within(status).getByRole('button', { name: 'See the resources' }));
    expect(onOpenTab).toHaveBeenCalledWith('resources');
  });

  it('says so while nobody has signed it off', async () => {
    mount({ summary: { reviews: [], current: 1, latestSignOff: null } });
    const status = await screen.findByTestId('sign-off-status');
    expect(status).toHaveTextContent('Nobody has signed off what this role contains yet.');
    expect(status).toHaveTextContent('It contains 1 resource now.');
    expect(within(status).queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Earlier reviews' })).toBeNull();
  });

  it('lists every review, newest first, with its notes and who wrote them', async () => {
    mount();
    const history = await screen.findByRole('region', { name: 'Earlier reviews' });
    const items = within(history).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('bob@example.test');
    expect(items[0]).toHaveTextContent('Why is SG-HR in here?');
    expect(items[0]).not.toHaveTextContent('Signed off');
    expect(items[1]).toHaveTextContent('Ann Analyst');
    expect(items[1]).toHaveTextContent('Signed off');
  });

  it('saves notes and a sign-off, then shows the new review and clears the form', async () => {
    const { state, user } = mount();
    const form = await screen.findByRole('form', { name: 'Your review' });
    const save = within(form).getByRole('button', { name: 'Save review' });
    expect(save).toBeDisabled();
    await user.type(within(form).getByLabelText('Notes'), 'Checked with the team.');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(save);
    await waitFor(() => expect(state.posts).toEqual([{ notes: 'Checked with the team.', signedOff: true }]));
    expect(await screen.findByText('Checked with the team.', { selector: 'p' })).toBeInTheDocument();
    expect(within(form).getByLabelText('Notes')).toHaveValue('');
    expect(within(form).getByRole('checkbox')).not.toBeChecked();
  });

  it('lets someone sign off without notes', async () => {
    const { state, user } = mount();
    const form = await screen.findByRole('form', { name: 'Your review' });
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(state.posts).toEqual([{ notes: '', signedOff: true }]));
  });

  it('shows the API error and keeps what was typed', async () => {
    const { user } = mount({ failPost: true });
    const form = await screen.findByRole('form', { name: 'Your review' });
    await user.type(within(form).getByLabelText('Notes'), 'x');
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Write a note or sign off');
    expect(within(form).getByLabelText('Notes')).toHaveValue('x');
  });

  it('gives someone without the permission, or a shared view, the reviews without the form', async () => {
    mount({ auth: READER });
    await screen.findByTestId('sign-off-status');
    expect(screen.queryByRole('form', { name: 'Your review' })).toBeNull();
  });

  it('has no form in a shared view, whatever the permissions', async () => {
    mount({ shared: true });
    await screen.findByTestId('sign-off-status');
    expect(screen.queryByRole('form', { name: 'Your review' })).toBeNull();
  });

  it('says so when the reviews cannot be loaded', async () => {
    mount({ failGet: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('The reviews could not be loaded');
  });
});
