// @vitest-environment jsdom
//
// The matrix wizard's "+ Organisation" dialog (T8): what it asks the API and the
// exact condition JSON it hands back for each way of narrowing.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import OrgConditionPicker from './OrgConditionPicker';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';

const CONTOSO = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Contoso Bank', entityType: 'Klant' };
const NORTHWIND = { id: '22222222-2222-4222-8222-222222222222', displayName: 'Northwind', entityType: 'Klant' };

const OPTIONS = {
  entityType: 'Klant', entityCount: 61,
  attributes: [
    { key: 'iso27001', distinct: 2, values: [{ value: 'Ja', count: 14 }, { value: 'Nee', count: 47 }] },
    { key: 'klantnummer', distinct: 61, values: [], free: true },
  ],
  vias: [
    { name: 'eigenaar', kind: 'direct', targets: ['Principal'], links: 58 },
    { name: 'Uren', kind: 'through', targets: ['Principal'], links: 839 },
    { name: 'applicatie', kind: 'direct', targets: ['Resource'], links: 12 },
  ],
};

function makeFetch() {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.startsWith('/api/org-truth/model')) return { entityTypes: [{ type: 'Klant', count: 61 }, { type: 'Uren', count: 900 }] };
    if (u.startsWith('/api/org-truth/filter-options')) return OPTIONS;
    if (u.startsWith('/api/org-truth/entities')) return { data: u.includes('q=North') ? [NORTHWIND] : [CONTOSO, NORTHWIND], total: 2 };
    return undefined;
  });
}

function renderPicker(entity = 'Principal') {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const authFetch = makeFetch();
  renderWithProviders(h(OrgConditionPicker, { entity, onPick, onClose }), { auth: { authFetch } });
  return { onPick, onClose, authFetch, user: userEvent.setup() };
}

const addButton = () => screen.getByRole('button', { name: 'Add' });

async function chooseKlant(user) {
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Kind of entity' }), await screen.findByRole('option', { name: 'Klant' }));
  await screen.findByRole('combobox', { name: /Attribute/ });
}

describe('OrgConditionPicker', () => {
  it('keeps Add disabled until a kind is chosen, then allows "every Klant"', async () => {
    const { user, onPick, authFetch } = renderPicker();
    expect(addButton()).toBeDisabled();
    await chooseKlant(user);
    expect(authFetch.mock.calls.map(c => c[0])).toContain('/api/org-truth/filter-options?type=Klant');
    expect(screen.getByText('No attribute or entity picked: every Klant counts.')).toBeInTheDocument();
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({ kind: 'org', entityType: 'Klant' });
  });

  it('builds an attribute condition from ticked values', async () => {
    const { user, onPick } = renderPicker();
    await chooseKlant(user);
    await user.selectOptions(screen.getByRole('combobox', { name: /Attribute/ }), 'iso27001');
    // A key with no value ticked is not a condition.
    expect(addButton()).toBeDisabled();
    expect(screen.queryByText(/every Klant counts/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /^Ja/ }));
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({ kind: 'org', entityType: 'Klant', attribute: { key: 'iso27001', values: ['Ja'] } });
  });

  it('lets a value be typed for a key whose values are not listed', async () => {
    const { user, onPick } = renderPicker();
    await chooseKlant(user);
    await user.selectOptions(screen.getByRole('combobox', { name: /Attribute/ }), 'klantnummer');
    await user.type(screen.getByRole('textbox', { name: 'Value of klantnummer' }), 'K-0042{Enter}');
    expect(screen.getByRole('checkbox', { name: 'K-0042' })).toBeChecked();
    await user.type(screen.getByRole('textbox', { name: 'Value of klantnummer' }), 'K-0043');
    await user.click(screen.getByRole('button', { name: 'Add value' }));
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({
      kind: 'org', entityType: 'Klant', attribute: { key: 'klantnummer', values: ['K-0042', 'K-0043'] },
    });
  });

  it('hand-picks entities through the search and records their labels', async () => {
    const { user, onPick, authFetch } = renderPicker();
    await chooseKlant(user);
    await user.type(screen.getByRole('textbox', { name: /Pick entities/ }), 'North');
    await user.click(await screen.findByRole('checkbox', { name: 'Northwind' }, { timeout: 2000 }));
    expect(authFetch.mock.calls.map(c => c[0])).toContain('/api/org-truth/entities?type=Klant&q=North&pageSize=20');
    const picked = screen.getByRole('list', { name: 'Picked entities' });
    expect(within(picked).getByText('Northwind')).toBeInTheDocument();
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({
      kind: 'org', entityType: 'Klant', entityIds: [NORTHWIND.id], labels: { [NORTHWIND.id]: 'Northwind' },
    });
  });

  it('un-picks an entity from its chip', async () => {
    const { user, onPick } = renderPicker();
    await chooseKlant(user);
    await user.type(screen.getByRole('textbox', { name: /Pick entities/ }), 'North');
    await user.click(await screen.findByRole('checkbox', { name: 'Northwind' }, { timeout: 2000 }));
    await user.click(screen.getByRole('button', { name: 'Remove Northwind' }));
    expect(screen.queryByRole('list', { name: 'Picked entities' })).not.toBeInTheDocument();
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({ kind: 'org', entityType: 'Klant' });
  });

  it('shows only the links that reach this side, all ticked, and sends via only once one is unticked', async () => {
    const { user, onPick } = renderPicker('Principal');
    await chooseKlant(user);
    const group = screen.getByRole('group', { name: 'Linked through' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map(b => b.closest('label').textContent)).toEqual([
      'eigenaar (direct, 58 links)', 'Uren (through rows, 839 links)',
    ]);
    expect(boxes.every(b => b.checked)).toBe(true);
    await user.click(within(group).getByRole('checkbox', { name: /^Uren/ }));
    await user.click(addButton());
    expect(onPick).toHaveBeenCalledWith({ kind: 'org', entityType: 'Klant', via: ['eigenaar'] });
  });

  it('refuses a condition with every link unticked', async () => {
    const { user } = renderPicker('Resource');
    await chooseKlant(user);
    const group = screen.getByRole('group', { name: 'Linked through' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(1);
    await user.click(within(group).getByRole('checkbox', { name: /^applicatie/ }));
    expect(addButton()).toBeDisabled();
    expect(screen.getByText('Tick at least one way of being linked.')).toBeInTheDocument();
  });

  it('says so when the options of a kind cannot be loaded', async () => {
    const onPick = vi.fn();
    const authFetch = makeAuthFetch((url) => (String(url).startsWith('/api/org-truth/model')
      ? { entityTypes: [{ type: 'Klant', count: 61 }] }
      : jsonResponse({ error: 'boom' }, { ok: false, status: 500 })));
    renderWithProviders(h(OrgConditionPicker, { entity: 'Principal', onPick, onClose: vi.fn() }), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Kind of entity' }), await screen.findByRole('option', { name: 'Klant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the options of Klant: HTTP 500');
    expect(screen.queryByRole('combobox', { name: /Attribute/ })).not.toBeInTheDocument();
  });

  it('closes on Cancel without picking', async () => {
    const { user, onPick, onClose } = renderPicker();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});
