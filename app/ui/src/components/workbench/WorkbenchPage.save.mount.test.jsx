// @vitest-environment jsdom
// Save and reopen (M2a) in the mounted workbench: what is sent, what the strip and
// the proposed-roles badge say, opening a saved investigation (its view and draft
// back, the access change counted), asking before losing unsaved work, deleting,
// and a refused save shown.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import WorkbenchPage from './WorkbenchPage';

// Organisation knowledge on: the workbench is part of it (the off case: WorkbenchPage.mount.test.jsx).
vi.mock('@ui/hooks/useOrgKnowledge', () => ({ useOrgKnowledge: () => true }));
import { renderWithProviders, screen, within, waitFor, userEvent, jsonResponse, makeAuthFetch, fireEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = 'u-9';
const INV = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';

const workbench = () => ({
  unit: { id: UNIT, displayName: 'Motor Claims', contextType: 'Team', targetType: 'Identity' },
  scope: { includeChildren: true, units: 1, truncatedPeople: false, maxPeople: 400 },
  kinds: [],
  people: [{ key: 'i:p', identityId: 'p', principalId: null, displayName: 'Piet Jansen', email: null, jobTitle: 'Handler', direct: true, units: ['Motor Claims'], accounts: [{ id: 'acc-p', displayName: 'Piet Jansen', systemName: 'Dir' }], knowledge: [] }],
  columns: [{ id: 'g1', displayName: 'Garage portal', resourceType: 'Group', systemName: 'Dir', isRole: false, holders: 1, contains: [] }],
  truncatedColumns: 0,
  cells: [{ person: 'i:p', resourceId: 'g1', type: 'Direct', accounts: ['acc-p'], viaRoles: [] }],
  generatedAt: '2026-10-27T11:00:00.000Z',
});

const savedInv = (over = {}) => ({
  id: INV, contextId: UNIT, name: 'Motor', description: null, view: {}, accessReadAt: '2026-10-27T11:00:00.000Z',
  createdBy: 'ann@x.test', createdAt: '2026-10-27T11:05:00.000Z', updatedBy: 'ann@x.test', updatedAt: '2026-10-27T11:05:00.000Z',
  accessCells: ['i:p|g1|Direct'], marks: [], proposals: [{ id: S1, name: 'Candidate 1', description: null, baseBusinessRoleId: null, members: [], entitlements: [] }],
  ...over,
});

function api(routes) {
  const calls = [];
  const fetch = makeAuthFetch((url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });
    const key = `${method} ${url.split('?')[0]}`;
    if (routes[key]) return routes[key](body);
    if (method === 'GET' && url.startsWith(`/api/contexts/${UNIT}/workbench?`)) return workbench();
    return undefined;
  });
  return { fetch, calls };
}

async function mount(routes = {}) {
  const user = userEvent.setup();
  const a = api(routes);
  renderWithProviders(h(WorkbenchPage, { contextId: UNIT, onClose: () => {} }), { auth: { authFetch: a.fetch } });
  await screen.findByRole('heading', { name: 'Motor Claims' }, { timeout: 5000 });
  fireEvent.click(screen.getByRole('button', { name: 'People as rows' }));
  return { user, calls: a.calls };
}

const status = () => document.querySelector('[data-investigation-status]').textContent;
const badge = () => within(screen.getByRole('complementary', { name: 'Candidate role' })).getByText(/^Draft · /).textContent;
const LIST = `GET /api/contexts/${UNIT}/workbench/investigations`;

describe('saving', () => {
  it('saves the work under a name, then saves over it with the time it was opened at', async () => {
    const { user, calls } = await mount({
      [`POST /api/contexts/${UNIT}/workbench/investigations`]: () => savedInv(),
      [`PUT /api/workbench/investigations/${INV}`]: (body) => savedInv({
        updatedBy: 'bob@x.test', updatedAt: '2026-10-27T11:30:00.000Z',
        proposals: body.proposals.map((p, i) => ({ ...p, id: i === 0 ? S1 : S2 })),
      }),
    });
    expect(status()).toBe('Nothing to save yet');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    expect(status()).toBe('Not saved — this work lives in this tab only');
    expect(badge()).toBe('Draft · not saved');

    await user.click(screen.getByRole('button', { name: 'Save…' }));
    await user.type(screen.getByRole('textbox', { name: 'Investigation name' }), 'Motor');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor” · ann@x.test, /));
    const post = calls.find(c => c.method === 'POST');
    expect(post.body).toMatchObject({ name: 'Motor', accessReadAt: '2026-10-27T11:00:00.000Z', accessCells: ['i:p|g1|Direct'], marks: [] });
    expect(post.body.proposals).toEqual([{ id: 'draft:1', name: 'Candidate 1', description: null, baseBusinessRoleId: null, members: [], entitlements: [],
      kind: null, rule: null, excluded: [], joinerPolicy: 'auto', leaverPolicy: 'remove', approver: null, rationale: null }]);
    expect(badge()).toBe('Draft · saved');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    expect(status()).toBe('Unsaved changes to “Motor”');
    expect(badge()).toBe('Draft · unsaved changes');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor” · bob@x.test, /));
    const put = calls.find(c => c.method === 'PUT');
    expect(put.body.expectedUpdatedAt).toBe('2026-10-27T11:05:00.000Z');
    // The saved proposed role goes by its saved id now; the new one by its handle.
    expect(put.body.proposals.map(p => p.id)).toEqual([S1, 'draft:2']);
    expect('name' in put.body).toBe(false);
  });

  it('shows why a save was refused, and stays unsaved', async () => {
    const { user } = await mount({
      [`POST /api/contexts/${UNIT}/workbench/investigations`]: () => jsonResponse({ error: 'This unit already has an investigation with that name.' }, { ok: false, status: 409 }),
    });
    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    await user.click(screen.getByRole('button', { name: 'Save…' }));
    await user.type(screen.getByRole('textbox', { name: 'Investigation name' }), 'Motor');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This unit already has an investigation with that name.')).toBeInTheDocument();
    expect(status()).toBe('Not saved — this work lives in this tab only');
    expect(screen.getByRole('textbox', { name: 'Investigation name' })).toBeInTheDocument();
  });
});

describe('opening', () => {
  const listed = { id: INV, name: 'Motor', updatedBy: 'ann@x.test', updatedAt: '2026-10-27T11:05:00.000Z', accessReadAt: '2026-10-26T08:00:00.000Z', markCount: 1, proposals: [{ id: S1, name: 'Claims handler' }] };

  it('lists the unit’s investigations and opens one: its view, marks and proposed roles back, the access change counted', async () => {
    const { user, calls } = await mount({
      [LIST]: () => ({ data: [listed] }),
      [`GET /api/workbench/investigations/${INV}`]: () => savedInv({
        view: { includeChildren: false, columns: ['displayName'] },
        accessCells: ['i:p|g1|Eligible', 'i:p|g2|Direct'],
        marks: [{ person: 'i:p', resourceId: 'g1', mark: 'investigate' }],
        proposals: [{ id: S1, name: 'Claims handler', description: null, baseBusinessRoleId: null, members: ['i:p'], entitlements: ['g1'] }],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Open… ▾' }));
    const list = await screen.findByRole('list', { name: 'Saved investigations' });
    expect(within(list).getByText(/ann@x.test, .* · access as read .* · 1 proposed role · 1 marks/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor”/));
    // The saved view is back: sub-units out, so the workbench is read again that way.
    await waitFor(() => expect(calls.some(c => c.url === `/api/contexts/${UNIT}/workbench?includeChildren=false`)).toBe(true));
    const roles = within(screen.getByRole('complementary', { name: 'Candidate role' })).getByRole('list', { name: 'Proposed roles' });
    expect(within(roles).getAllByRole('button').map(b => b.textContent)).toEqual(['Claims handler1 · 1']);
    // g1 held another way, g2 no longer held.
    expect(screen.getByText(/Access read again since you saved: 2 cells differ/)).toBeInTheDocument();
    expect(badge()).toBe('Draft · saved');
  });

  it('asks before opening over unsaved work', async () => {
    const { user, calls } = await mount({ [LIST]: () => ({ data: [listed] }), [`GET /api/workbench/investigations/${INV}`]: () => savedInv() });
    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    await user.click(screen.getByRole('button', { name: 'Open… ▾' }));
    await user.click(within(await screen.findByRole('list', { name: 'Saved investigations' })).getByRole('button', { name: 'Open' }));
    expect(screen.getByText('Your unsaved changes will be lost.')).toBeInTheDocument();
    expect(calls.some(c => c.url === `/api/workbench/investigations/${INV}`)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open anyway' }));
    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor”/));
  });

  it('says when nothing is saved yet, and deletes one after asking', async () => {
    const { user, calls } = await mount({
      [LIST]: () => ({ data: [listed] }),
      [`DELETE /api/workbench/investigations/${INV}`]: () => ({ ok: true }),
    });
    await user.click(screen.getByRole('button', { name: 'Open… ▾' }));
    const list = await screen.findByRole('list', { name: 'Saved investigations' });
    await user.click(within(list).getByRole('button', { name: 'Delete Motor' }));
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await user.click(within(list).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('Nothing saved on this unit yet.')).toBeInTheDocument());
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual([`/api/workbench/investigations/${INV}`]);
  });
});

describe('saving a role from the panel', () => {
  const panel = () => screen.getByRole('complementary', { name: 'Candidate role' });

  it('asks what the role still needs, then saves it under a suggested name, and starts the next role with its kind to choose', async () => {
    const { user, calls } = await mount({
      [`POST /api/contexts/${UNIT}/workbench/investigations`]: (body) => savedInv({ name: body.name, proposals: body.proposals.map(p => ({ ...p, id: S1 })) }),
    });
    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    const before = within(panel()).getByRole('list', { name: 'Before saving' });
    expect(before).toHaveTextContent('Choose how it is assigned');
    expect(before).toHaveTextContent('Add at least one entitlement');
    expect(within(panel()).getByRole('button', { name: 'Save role' })).toBeDisabled();
    // Its kind, and an entitlement.
    await user.click(within(panel()).getByRole('button', { name: /^Requestable — people request it/ }));
    await user.click(screen.getByRole('button', { name: /^Select the column Garage portal/ }));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    expect(within(panel()).queryByRole('list', { name: 'Before saving' })).toBeNull();
    // A first save asks the investigation's name here: "<unit> — dd-mm-yyyy".
    const name = within(panel()).getByRole('textbox', { name: 'Save the investigation as' });
    expect(name.value).toMatch(/^Motor Claims — \d{2}-\d{2}-\d{4}$/);
    await user.click(within(panel()).getByRole('button', { name: 'Save and start the next role' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    // Saved — and the next role is new work on it.
    await waitFor(() => expect(status()).toMatch(/^Unsaved changes to “Motor Claims — \d{2}-\d{2}-\d{4}”$/));
    const post = calls.find(c => c.method === 'POST');
    expect(post.body.proposals[0]).toMatchObject({ kind: 'requestable', entitlements: ['g1'], members: ['i:p'] });
    // The next role: open, its kind to choose, the first one kept in the list.
    expect(within(panel()).getByRole('group', { name: 'How is this role assigned?' })).toBeInTheDocument();
    expect(within(panel()).getByRole('list', { name: 'Proposed roles' }).children).toHaveLength(2);
    // The first role stays saved while the next one is new work.
    await user.click(within(within(panel()).getByRole('list', { name: 'Proposed roles' })).getAllByRole('button')[0]);
    expect(within(panel()).getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText(/Click a cell, Shift-click for a rectangle/)).toBeInTheDocument();
  });

  it('saves over the saved investigation without asking a name, and says the role is saved', async () => {
    const { user, calls } = await mount({
      [`POST /api/contexts/${UNIT}/workbench/investigations`]: (body) => savedInv({ name: body.name, proposals: body.proposals.map(p => ({ ...p, id: S1 })) }),
      [`PUT /api/workbench/investigations/${INV}`]: (body) => savedInv({ updatedAt: '2026-10-27T12:00:00.000Z', proposals: body.proposals.map(p => ({ ...p, id: S1 })) }),
    });
    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    await user.click(within(panel()).getByRole('button', { name: /^Rule-based — assigned automatically/ }));
    await user.click(screen.getByRole('button', { name: /^Select the column Garage portal/ }));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    expect(within(panel()).getByText('It will be saved with members chosen by hand — it has no assignment rule yet.')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(within(panel()).getByText('Saved')).toBeInTheDocument());
    expect(within(panel()).queryByRole('textbox', { name: 'Save the investigation as' })).toBeNull();
    await user.type(within(panel()).getByPlaceholderText('e.g. Claims handler — motor'), 'x');
    expect(within(panel()).queryByText('Saved')).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
  });
});

describe('a refused save from the panel', () => {
  it('says why under the role', async () => {
    const { user } = await mount({
      [`POST /api/contexts/${UNIT}/workbench/investigations`]: () => jsonResponse({ error: 'This unit already has an investigation with that name.' }, { ok: false, status: 409 }),
    });
    const panel = () => screen.getByRole('complementary', { name: 'Candidate role' });
    await user.click(screen.getByRole('button', { name: 'New candidate role' }));
    await user.click(within(panel()).getByRole('button', { name: /^Requestable — people request it/ }));
    await user.click(screen.getByRole('button', { name: /^Select the column Garage portal/ }));
    await user.click(screen.getByRole('button', { name: 'Add to candidate' }));
    await user.click(within(panel()).getByRole('button', { name: 'Save role' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('This unit already has an investigation with that name.');
  });
});

describe('opened on a link to one saved proposed role', () => {
  const two = () => savedInv({ proposals: [
    { id: S1, name: 'Claims handler', description: null, baseBusinessRoleId: null, members: ['i:p'], entitlements: ['g1'] },
    { id: S2, name: 'Garage liaison', description: null, baseBusinessRoleId: null, members: [], entitlements: ['g1'] },
  ] });

  async function mountLinked(routeId, routes) {
    const a = api(routes);
    renderWithProviders(h(WorkbenchPage, { contextId: routeId, onClose: () => {} }), { auth: { authFetch: a.fetch } });
    await screen.findByRole('heading', { name: 'Motor Claims' }, { timeout: 5000 });
    return a.calls;
  }
  const active = () => within(screen.getByRole('list', { name: 'Proposed roles' })).getAllByRole('button').find(b => b.getAttribute('aria-current') === 'true');

  it('reads the unit, opens the investigation once and puts that role in the panel', async () => {
    const calls = await mountLinked(`${UNIT}:${INV}:${S2}`, { [`GET /api/workbench/investigations/${INV}`]: two });
    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor”/));
    await waitFor(() => expect(active()).toHaveTextContent('Garage liaison'));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Garage liaison');
    expect(calls.filter(c => c.url === `/api/workbench/investigations/${INV}`)).toHaveLength(1);
    expect(calls.some(c => c.url.startsWith(`/api/contexts/${UNIT}/workbench?`))).toBe(true);
  });

  it('keeps the first role open when the linked one is gone', async () => {
    await mountLinked(`${UNIT}:${INV}:44444444-4444-4444-8444-444444444444`, { [`GET /api/workbench/investigations/${INV}`]: two });
    await waitFor(() => expect(status()).toMatch(/^Saved as “Motor”/));
    expect(active()).toHaveTextContent('Claims handler');
  });

  it('opens no investigation on the unit alone', async () => {
    const calls = await mountLinked(UNIT, {});
    expect(status()).toBe('Nothing to save yet');
    expect(calls.some(c => c.url.startsWith('/api/workbench/investigations/'))).toBe(false);
  });
});
