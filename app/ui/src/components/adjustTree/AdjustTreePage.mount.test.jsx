// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AdjustTreePage from './AdjustTreePage';
import { renderWithProviders, screen, within, waitFor, userEvent, jsonResponse, makeAuthFetch } from '@ui/test-utils/renderWithProviders';
import { TREE, TREE_KEY, KEY_IN_URL, adjustTreeApi, writesOf } from '@ui/test-utils/adjustTreeFixtures';

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

function mount({ api = adjustTreeApi(), auth = {}, props = {} } = {}) {
  const user = userEvent.setup();
  const result = renderWithProviders(h(AdjustTreePage, { treeKey: TREE_KEY, onClose: () => {}, ...props }), { auth: { authFetch: api, ...auth } });
  return { user, api, ...result };
}

const unitButton = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const treePane = () => screen.getByRole('region', { name: 'Tree' });
const detailsPane = () => screen.getByRole('region', { name: 'Details' });

describe('AdjustTreePage — the tree', () => {
  it('draws the tree with its counts and marks, and the header', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Organisation', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Generated from Entra ID')).toBeInTheDocument();
    // Two of the three adjustments still count.
    expect(screen.getByText('2 adjustments')).toBeInTheDocument();
    const tree = treePane();
    expect(within(tree).getByRole('button', { name: 'Board (Anna de Vries)' })).toBeInTheDocument();
    expect(within(tree).getByText('5 / 20')).toBeInTheDocument();
    // Finance is open from the start (level below the top), so Accounting shows.
    expect(within(tree).getByRole('button', { name: /^Accounting/ })).toBeInTheDocument();
    const row = (name) => within(within(tree).getByRole('button', { name: new RegExp('^' + name) }).parentElement);
    expect(row('Finance').getByText('adjusted')).toBeInTheDocument();
    expect(row('Board').queryByText('adjusted')).not.toBeInTheDocument();
    expect(row('Staff').getByText('added by hand')).toBeInTheDocument();
    expect(row('IT').getByText(/^interim until .*2027/)).toBeInTheDocument();
    expect(row('IT').getByText('6')).toBeInTheDocument();
  });

  it('selects the first top unit, and another on click', async () => {
    const { user } = mount();
    await screen.findByRole('region', { name: 'Details' });
    expect(within(detailsPane()).getByRole('heading', { name: 'Board' })).toBeInTheDocument();
    await user.click(unitButton('IT'));
    const panel = detailsPane();
    expect(within(panel).getByRole('heading', { name: 'IT' })).toBeInTheDocument();
    expect(within(panel).getByText(/Bram Mertens interim until/)).toBeInTheDocument();
    expect(within(panel).getByText('6 direct · 6 in total')).toBeInTheDocument();
  });

  it('collapses a unit and finds units by name, opening the way to them', async () => {
    const { user } = mount();
    await screen.findByRole('heading', { name: 'Organisation' });
    await user.click(screen.getByRole('button', { name: 'Collapse Finance' }));
    expect(within(treePane()).queryByRole('button', { name: /^Accounting/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Find a unit' }), 'acc');
    const tree = treePane();
    expect(within(tree).getByRole('button', { name: /^Accounting/ })).toBeInTheDocument();
    expect(within(tree).getByText('match')).toBeInTheDocument();
    // Units outside the way to the match are hidden.
    expect(within(tree).queryByRole('button', { name: /^IT/ })).not.toBeInTheDocument();
    expect(within(tree).queryByRole('button', { name: /^Staff/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Find a unit' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a unit' }), 'nothing here');
    expect(within(treePane()).getByText('Nothing matches "nothing here".')).toBeInTheDocument();
  });

  it('lists the members of the open units when "Show people" is on', async () => {
    const { user, api } = mount();
    await screen.findByRole('heading', { name: 'Organisation' });
    await user.click(screen.getByRole('checkbox', { name: 'Show people' }));
    const tree = treePane();
    expect(await within(tree).findByText('Saar Dekker')).toBeInTheDocument();
    expect(within(tree).getByText('Tom Hendriks')).toBeInTheDocument();
    const urls = api.mock.calls.map(([u]) => u);
    expect(urls).toContain('/api/contexts/u-board/members?limit=200');
    // A closed unit is not read.
    expect(urls.some(u => u.startsWith('/api/contexts/u-acc/members?limit=200'))).toBe(false);
  });

  it('relabels its tab with the tree name, but not when embedded in a run', async () => {
    const onCacheData = vi.fn();
    mount({ props: { onCacheData } });
    await waitFor(() => expect(onCacheData).toHaveBeenCalledWith(TREE_KEY, 'adjust-tree', { displayName: 'Adjust: Organisation' }));
    const embedded = vi.fn();
    mount({ props: { onCacheData: embedded, embedded: true } });
    await screen.findAllByRole('heading', { name: 'Organisation' });
    expect(embedded).not.toHaveBeenCalled();
  });

  it('says so when the tree cannot be read, and reads it again on Try again', async () => {
    let ok = false;
    const api = makeAuthFetch((url) => (ok ? adjustTreeApi()(url) : jsonResponse({ error: 'Tree not found' }, { ok: false, status: 404 })));
    const { user } = mount({ api });
    expect(await screen.findByText('Could not load the tree')).toBeInTheDocument();
    expect(screen.getByText('Tree not found')).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Organisation', level: 1 })).toBeInTheDocument();
  });
});

describe('AdjustTreePage — changing the tree', () => {
  it('moves a unit from the panel, with its reason, re-reads, and Undo takes it back', async () => {
    const { user, api } = mount();
    await user.click(await screen.findByRole('button', { name: /^Finance/ }));
    const reads = api.mock.calls.filter(([u]) => u === `/api/context-trees/${KEY_IN_URL}`).length;
    await user.click(screen.getByRole('button', { name: 'Move under…' }));
    await user.selectOptions(screen.getByLabelText('Move under'), 'Staff');
    await user.type(screen.getByLabelText('Reason'), 'Reorg');
    await user.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(writesOf(api)).toEqual([
      { method: 'POST', url: `/api/context-trees/${KEY_IN_URL}/adjustments`, body: { op: 'moveUnit', subjectId: 'u-fin', toParentId: 'u-staff', reason: 'Reorg' } },
    ]));
    const toast = (await screen.findByText('Done moveUnit')).closest('[role="status"]');
    expect(api.mock.calls.filter(([u]) => u === `/api/context-trees/${KEY_IN_URL}`).length).toBe(reads + 1);
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(writesOf(api)[1]).toEqual({ method: 'DELETE', url: `/api/context-trees/${KEY_IN_URL}/adjustments/a11`, body: undefined }));
  });

  it('offers the top level as a move target only to a unit that is not at the top', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: /^Finance/ }));
    await user.click(screen.getByRole('button', { name: 'Move under…' }));
    const options = within(screen.getByLabelText('Move under')).getAllByRole('option').map(o => o.textContent);
    // Not itself, not its own sub-unit Accounting, not its parent Board.
    expect(options).toEqual(['(pick a unit)', 'Top level', 'IT', 'Staff']);
  });

  it('renames a unit without a reason field in the body when none was typed', async () => {
    const { user, api } = mount();
    await user.click(await screen.findByRole('button', { name: /^IT/ }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('New name');
    await user.clear(field);
    await user.type(field, 'IT & Security');
    await user.click(within(screen.getByRole('form', { name: 'Rename' })).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([{ op: 'renameUnit', subjectId: 'u-it', name: 'IT & Security' }]));
  });

  it('adds a sub-unit under the selected unit', async () => {
    const { user, api } = mount();
    await screen.findByRole('heading', { name: 'Board', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Add sub-unit' }));
    await user.type(screen.getByLabelText('Name of the new unit'), 'Staff office');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([{ op: 'addUnit', parentId: 'u-board', name: 'Staff office' }]));
  });

  it('shows the API\'s refusal and keeps the form open', async () => {
    const { user } = mount({ api: adjustTreeApi({ fail: 'That unit is gone' }) });
    await screen.findByRole('heading', { name: 'Board', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Add sub-unit' }));
    await user.type(screen.getByLabelText('Name of the new unit'), 'X');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('That unit is gone')).toBeInTheDocument();
    expect(screen.getByLabelText('Name of the new unit')).toHaveValue('X');
  });

  it('groups the picked units under a new unit: adds it, then moves each under it', async () => {
    const after = { ...TREE, units: [...TREE.units, { ...TREE.units[0], id: 'u-new', parentId: 'u-board', name: 'Support' }] };
    const { user, api } = mount({ api: adjustTreeApi({ treeAfterWrite: after }) });
    await screen.findByRole('heading', { name: 'Organisation' });
    await user.click(screen.getByRole('checkbox', { name: 'Pick Finance' }));
    await user.click(screen.getByRole('checkbox', { name: 'Pick IT' }));
    expect(screen.getByText('2 units picked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Group into new unit…' }));
    expect(screen.getByText(/A new unit under Board, with the 2 picked units moved under it/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name of the new unit'), 'Support');
    await user.click(screen.getByRole('button', { name: 'Group' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([
      { op: 'addUnit', parentId: 'u-board', name: 'Support' },
      { op: 'moveUnit', subjectId: 'u-fin', toParentId: 'u-new' },
      { op: 'moveUnit', subjectId: 'u-it', toParentId: 'u-new' },
    ]));
    // Done: the picks are cleared.
    await waitFor(() => expect(screen.queryByText('2 units picked')).not.toBeInTheDocument());
  });

  it('adds a level above a unit at its own place', async () => {
    const after = { ...TREE, units: [...TREE.units, { ...TREE.units[0], id: 'u-top', parentId: null, name: 'Company' }] };
    const { user, api } = mount({ api: adjustTreeApi({ treeAfterWrite: after }) });
    await screen.findByRole('heading', { name: 'Board', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Add a level above' }));
    await user.type(screen.getByLabelText('Name of the new unit'), 'Company');
    await user.click(screen.getByRole('button', { name: 'Add level' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([
      { op: 'addUnit', parentId: null, name: 'Company' },
      { op: 'moveUnit', subjectId: 'u-board', toParentId: 'u-top' },
    ]));
  });

  it('reports a new unit it cannot find instead of moving units somewhere else', async () => {
    const { user, api } = mount();
    await screen.findByRole('heading', { name: 'Board', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Add a level above' }));
    await user.type(screen.getByLabelText('Name of the new unit'), 'Company');
    await user.click(screen.getByRole('button', { name: 'Add level' }));
    expect(await screen.findByText(/could not be found to move the units under it/)).toBeInTheDocument();
    expect(writesOf(api).map(w => w.body.op)).toEqual(['addUnit']);
  });
});

describe('AdjustTreePage — Not placed', () => {
  it('lists Not placed last, cannot pick or change it, and says what it holds', async () => {
    const notPlaced = { ...TREE.units[4], id: 'u-np', name: 'Aaa not placed', notPlaced: true, createdByAdjustment: false, memberCount: 2, totalMemberCount: 2 };
    const { user } = mount({ api: adjustTreeApi({ tree: { ...TREE, units: [...TREE.units, notPlaced] } }) });
    await screen.findByRole('heading', { name: 'Organisation', level: 1 });
    const units = screen.getByRole('list', { name: 'Units' });
    const topNames = [...units.children].map(li => li.querySelector('button[aria-current], button:not([aria-label])').textContent);
    expect(topNames).toEqual(['Board (Anna de Vries)', 'Staff', 'Aaa not placed']);
    expect(screen.queryByRole('checkbox', { name: 'Pick Aaa not placed' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Pick Staff' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Aaa not placed' }));
    expect(within(detailsPane()).getByText(/not under the top of the tree/)).toBeInTheDocument();
    expect(within(detailsPane()).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });
});

describe('AdjustTreePage — read only', () => {
  it('shows the tree without any way to change it', async () => {
    const { user } = mount({ auth: READER });
    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^Pick / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh from source' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Needs attention/ }));
    // Only the "show me" fix is offered to a reader.
    expect(screen.getByRole('button', { name: 'Show them' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow the suggestion' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Split off Data' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Adjustments/ }));
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Redo/ })).not.toBeInTheDocument();
  });

  it('is read only for a tree the API says cannot be adjusted, even for an editor', async () => {
    mount({ api: adjustTreeApi({ tree: { ...TREE, canAdjust: false } }) });
    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Split…' })).not.toBeInTheDocument();
  });
});
