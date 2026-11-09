// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import AdjustTreePage from './AdjustTreePage';
import { renderWithProviders, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
import { TREE, TREE_KEY, KEY_IN_URL, adjustTreeApi, writesOf } from '@ui/test-utils/adjustTreeFixtures';

// The side panel of the Adjust tree screen: Needs attention, the adjustments
// log, and the two richer unit actions (Split…, Set manager…).

const BASE = `/api/context-trees/${KEY_IN_URL}`;

async function mount(apiOptions) {
  const user = userEvent.setup();
  const api = adjustTreeApi(apiOptions);
  renderWithProviders(h(AdjustTreePage, { treeKey: TREE_KEY }), { auth: { authFetch: api } });
  await screen.findByRole('heading', { name: 'Organisation', level: 1 });
  return { user, api };
}

const details = () => screen.getByRole('region', { name: 'Details' });

describe('Needs attention', () => {
  it('counts the items on its tab and the live adjustments on the other', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: 'Needs attention 4' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Adjustments 2' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Unit' })).toHaveAttribute('aria-selected', 'true');
  });

  it('runs each one-click fix against its own route', async () => {
    const { user, api } = await mount();
    await user.click(screen.getByRole('tab', { name: /Needs attention/ }));
    await user.click(screen.getByRole('button', { name: 'Follow the suggestion' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({ method: 'POST', url: `${BASE}/adjustments/a1/follow`, body: undefined }));
    await user.click(screen.getByRole('button', { name: 'Remove adjustment' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({ method: 'DELETE', url: `${BASE}/adjustments/a2`, body: undefined }));
    await user.click(screen.getByRole('button', { name: 'Split off Data' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({
      method: 'POST', url: `${BASE}/adjustments`, body: { op: 'splitUnit', subjectId: 'u-it', attribute: 'department', value: 'Data' },
    }));
    expect(writesOf(api)).toHaveLength(3);
  });

  it('"select" shows the unit on the Unit tab without writing anything', async () => {
    const { user, api } = await mount();
    await user.click(screen.getByRole('tab', { name: /Needs attention/ }));
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    expect(screen.getByRole('tab', { name: 'Unit' })).toHaveAttribute('aria-selected', 'true');
    expect(within(details()).getByRole('heading', { name: 'Staff' })).toBeInTheDocument();
    expect(writesOf(api)).toEqual([]);
  });

  it('says when there is nothing to review', async () => {
    const { user } = await mount({ attention: [] });
    await user.click(screen.getByRole('tab', { name: /Needs attention/ }));
    expect(screen.getByText(/Nothing left to review/)).toBeInTheDocument();
  });
});

describe('Adjustments log', () => {
  it('lists the changes in the API\'s order with status, who and why', async () => {
    const { user } = await mount();
    await user.click(screen.getByRole('tab', { name: /Adjustments/ }));
    const entries = within(details()).getAllByRole('listitem');
    expect(entries.map(e => e.querySelector('p').textContent)).toEqual([
      'Rename Fin to "Finance"', 'Move IT under Operations', 'Rename Accounting to "Acc"',
    ]);
    expect(within(entries[0]).getByText('Applied')).toBeInTheDocument();
    expect(within(entries[0]).getByText(/Wim · .* · “HR typo”/)).toBeInTheDocument();
    expect(within(entries[1]).getByText('Needs your decision')).toBeInTheDocument();
    expect(within(entries[1]).getByText('Operations is no longer in the source.')).toBeInTheDocument();
    expect(within(entries[1]).getByText('Board')).toBeInTheDocument();
    expect(within(entries[2]).getByText('Undone')).toBeInTheDocument();
  });

  it('undoes a change, redoes an undone one, and follows or removes a suggestion', async () => {
    const { user, api } = await mount();
    await user.click(screen.getByRole('tab', { name: /Adjustments/ }));
    await user.click(screen.getByRole('button', { name: 'Undo: Rename Fin to "Finance"' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({ method: 'DELETE', url: `${BASE}/adjustments/a2`, body: undefined }));
    expect(await screen.findByText('Undone: Rename Fin to "Finance"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Redo: Rename Accounting to "Acc"' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({ method: 'POST', url: `${BASE}/adjustments/a0/redo`, body: undefined }));
    const decision = within(details()).getAllByRole('listitem')[1];
    await user.click(within(decision).getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(writesOf(api).at(-1).url).toBe(`${BASE}/adjustments/a1/follow`));
    await user.click(within(decision).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(writesOf(api).at(-1)).toEqual({ method: 'DELETE', url: `${BASE}/adjustments/a1`, body: undefined }));
  });

  it('shows what was adjusted on the selected unit', async () => {
    const { user } = await mount();
    expect(within(details()).getByText('Not adjusted. This unit is exactly as the source has it.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Finance/ }));
    expect(within(details()).getByText('Rename Fin to "Finance"')).toBeInTheDocument();
    // The undone rename of Accounting does not show on Accounting.
    await user.click(screen.getByRole('button', { name: /^Accounting/ }));
    expect(within(details()).getByText('Not adjusted. This unit is exactly as the source has it.')).toBeInTheDocument();
  });
});

describe('Split…', () => {
  const OPTIONS = [
    { attribute: 'department', label: 'Department', values: [{ value: 'Data', count: 3 }, { value: 'Apps', count: 3 }] },
    { attribute: 'jobTitle', label: 'Job title', values: [{ value: 'Developer', count: 2 }] },
  ];

  it('in a tree of people splits by one attribute value, from the counted choices', async () => {
    const { user, api } = await mount({ splitOptions: OPTIONS });
    await user.click(screen.getByRole('button', { name: /^IT/ }));
    await user.click(screen.getByRole('button', { name: 'Split…' }));
    const value = await screen.findByLabelText('Value');
    expect(within(value).getAllByRole('option').map(o => o.textContent)).toEqual(['(pick a value)', 'Data (3)', 'Apps (3)']);
    await user.selectOptions(screen.getByLabelText('Split by'), 'jobTitle');
    expect(within(screen.getByLabelText('Value')).getAllByRole('option').map(o => o.textContent)).toEqual(['(pick a value)', 'Developer (2)']);
    await user.selectOptions(screen.getByLabelText('Split by'), 'department');
    await user.selectOptions(screen.getByLabelText('Value'), 'Apps');
    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([{ op: 'splitUnit', subjectId: 'u-it', attribute: 'department', value: 'Apps' }]));
    expect(api.mock.calls.map(([u]) => u)).toContain(`${BASE}/units/u-it/split-options`);
  });

  it('in any other tree splits off the picked members under a new name', async () => {
    const { user, api } = await mount({ tree: { ...TREE, targetType: 'Resource' } });
    await screen.findByText('Saar Dekker');
    await user.click(screen.getByRole('button', { name: 'Split…' }));
    const split = screen.getByRole('button', { name: 'Split' });
    expect(split).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Saar Dekker/ }));
    expect(split).toBeDisabled(); // a name is still missing
    await user.type(screen.getByLabelText('Name of the new unit'), 'Secretariat');
    await user.click(split);
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([{ op: 'splitUnit', subjectId: 'u-board', memberIds: ['p-saar'], name: 'Secretariat' }]));
    // Not a people tree: the attribute choices are never asked for.
    expect(api.mock.calls.some(([u]) => u.includes('/split-options'))).toBe(false);
  });
});

describe('Set manager…', () => {
  it('sets an interim manager until a date', async () => {
    const { user, api } = await mount({ users: [{ id: 'p-mila', displayName: 'Mila Hoek' }] });
    await user.click(screen.getByRole('button', { name: 'Set manager…' }));
    await user.type(screen.getByLabelText('Find a person'), 'mil');
    await user.click(await screen.findByRole('button', { name: /Mila Hoek/ }));
    expect(screen.getByText('Mila Hoek', { selector: 'span' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Interim' }));
    await user.type(screen.getByLabelText('Until'), '2027-03-31');
    await user.click(screen.getByRole('button', { name: 'Set manager' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([
      { op: 'setManager', subjectId: 'u-board', principalId: 'p-mila', interim: true, validUntil: '2027-03-31' },
    ]));
  });

  it('sets a permanent manager without a date', async () => {
    const { user, api } = await mount({ users: [{ id: 'p-mila', displayName: 'Mila Hoek' }] });
    await user.click(screen.getByRole('button', { name: 'Set manager…' }));
    expect(screen.getByRole('button', { name: 'Set manager' })).toBeDisabled();
    await user.type(screen.getByLabelText('Find a person'), 'mil');
    await user.click(await screen.findByRole('button', { name: /Mila Hoek/ }));
    await user.click(screen.getByRole('button', { name: 'Set manager' }));
    await waitFor(() => expect(writesOf(api).map(w => w.body)).toEqual([{ op: 'setManager', subjectId: 'u-board', principalId: 'p-mila', interim: false }]));
  });
});

describe('Refresh from source', () => {
  it('re-runs the tree\'s rule through the sync route of one of its units', async () => {
    const { user, api } = await mount();
    await user.click(screen.getByRole('button', { name: 'Refresh from source' }));
    await waitFor(() => expect(writesOf(api)[0]).toEqual({ method: 'POST', url: '/api/contexts/u-board/sync', body: undefined }));
  });

  it('is not offered on an imported tree', async () => {
    await mount({ tree: { ...TREE, kind: 'synced' } });
    expect(screen.getByText('Imported from Entra ID')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh from source' })).not.toBeInTheDocument();
  });
});
