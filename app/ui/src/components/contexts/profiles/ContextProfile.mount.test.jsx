// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextProfile from './ContextProfile';
import { PROFILES } from './profiles';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// "Contoso" as three contexts — its people (this one), its accounts and its
// resources — linked by SameUnitAs. The accounts row carries no count, so the
// profile reads that context for it; the resources row is fetched too.
const PEOPLE = {
  id: 'c-ppl', displayName: 'Contoso', contextCategory: 'OrganizationalUnit', targetType: 'Identity',
  directMemberCount: 4, totalMemberCount: 12,
};
const LINKS = [
  { id: 'l1', relationshipType: 'SameUnitAs', relatedContextId: 'c-acc', relatedDisplayName: 'Contoso', relatedContextCategory: 'OrganizationalUnit', relatedTargetType: 'Principal', direction: 'out' },
  { id: 'l2', relationshipType: 'SameUnitAs', relatedContextId: 'c-res', relatedDisplayName: 'Contoso', relatedContextCategory: 'OrganizationalUnit', relatedTargetType: 'Resource', direction: 'in' },
];
const DETAILS = {
  'c-acc': { attributes: { id: 'c-acc', totalMemberCount: 15 } },
  'c-res': { attributes: { id: 'c-res', totalMemberCount: 31 } },
};

function api({ id = 'c-ppl', links = LINKS, roles = [], suggestion = null, details = DETAILS } = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u === `/api/contexts/${id}/relationships`) return links;
    if (u === `/api/contexts/${id}/roles/suggestion`) return suggestion || jsonResponse(undefined, { status: 204 });
    if (u === `/api/contexts/${id}/roles`) return roles;
    const m = /^\/api\/contexts\/([^/?]+)$/.exec(u);
    if (m && details[m[1]]) return details[m[1]];
    if (m) return jsonResponse({}, { ok: false, status: 500 });
    return undefined;
  });
}

function mount({ profile = PROFILES.OrganizationalUnit, attrs = PEOPLE, subContexts = [], onOpenDetail = vi.fn(), ...opts } = {}) {
  const authFetch = api({ id: attrs.id, ...opts });
  renderWithProviders(h(ContextProfile, { profile, attrs, subContexts, onOpenDetail }), { auth: { authFetch } });
  return { authFetch, onOpenDetail, user: userEvent.setup() };
}

const facts = (title) => screen.getByRole('region', { name: title });
const fact = (region, label) => within(region).getByText(label).nextElementSibling;

describe('ContextProfile — organisational unit', () => {
  it('shows Accountable with its suggestion, Responsible, the counts in the kind word, and sub-units', async () => {
    mount({
      subContexts: [{ id: 's1' }, { id: 's2' }],
      suggestion: { role: 'Accountable', principalId: 'p-9', displayName: 'Mara Lindqvist', reason: 'manages 11 of the 14 members' },
    });
    const region = facts('About this unit');
    expect(await within(region).findByTestId('best-guess')).toHaveTextContent('Mara Lindqvist');
    expect(within(region).getByRole('group', { name: 'Accountable' })).toHaveTextContent('Answers for who may access this unit');
    expect(within(region).getByRole('group', { name: 'Responsible' })).toHaveTextContent('Keeps the membership and access correct day to day');
    // The count matches the members list: direct, and with the sub-units.
    expect(fact(region, 'People')).toHaveTextContent(/^4 in this unit · 12 including sub-units$/);
    expect(fact(region, 'Sub-units')).toHaveTextContent('2');
  });

  it('switches between the variants of the unit, with each one\'s member count', async () => {
    const { onOpenDetail, user, authFetch } = mount();
    const group = await screen.findByRole('group', { name: 'This unit as' });
    await within(group).findByRole('button', { name: 'Resources 31' });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['People 12', 'Accounts 15', 'Resources 31']);
    expect(screen.getByTestId('unit-variants')).toHaveTextContent(/^This unit ass*People 12s*Accounts 15s*Resources 31$/);
    expect(within(group).getByRole('button', { name: 'People 12' })).toHaveAttribute('aria-pressed', 'true');
    // The counts came from reading each related context, not from merging members.
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-acc');
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/members'));

    await user.click(within(group).getByRole('button', { name: 'Accounts 15' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c-acc', 'Contoso');
    // Pressing this context itself opens nothing.
    onOpenDetail.mockClear();
    await user.click(within(group).getByRole('button', { name: 'People 12' }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('uses a count the relationship row already carries, and shows a dash for one it cannot read', async () => {
    const links = [{ ...LINKS[0], relatedTotalMemberCount: 7 }, LINKS[1]];
    const { authFetch } = mount({ links, details: {} });
    expect(await screen.findByRole('button', { name: 'Resources —' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accounts 7' })).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/c-acc');
  });

  it('leaves the section out when the unit is held as one kind only', async () => {
    const { authFetch } = mount({ links: [] });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-ppl/relationships'));
    expect(screen.queryByTestId('unit-variants')).toBeNull();
    expect(screen.queryByText(/variant|None yet/i)).toBeNull();
  });

  it('makes the counts links to the lists they count', async () => {
    const onShowMembers = vi.fn();
    const onShowSubUnits = vi.fn();
    renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs: PEOPLE, subContexts: [{ id: 's1' }], onShowMembers, onShowSubUnits }), { auth: { authFetch: api() } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '4 in this unit · 12 including sub-units' }));
    expect([onShowMembers.mock.calls.length, onShowSubUnits.mock.calls.length]).toEqual([1, 0]);
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(onShowSubUnits).toHaveBeenCalledTimes(1);
  });

  it('shows a count of no sub-units as plain text', () => {
    mount({ subContexts: [] });
    expect(screen.queryByRole('button', { name: '0' })).toBeNull();
    expect(fact(facts('About this unit'), 'Sub-units')).toHaveTextContent(/^0$/);
  });

  it('shows the actions area', async () => {
    mount();
    expect(await screen.findByRole('region', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByTestId('action-view-in-matrix')).toBeInTheDocument();
  });
});

describe('ContextProfile — the remaining attributes, once', () => {
  it('a business reader gets More details without the counts, flags or raw classification', async () => {
    const attrs = { ...PEOPLE, variant: 'synced', contextType: 'Department', userRenamed: false, lastCalculatedAt: '2026-10-20T12:06:02Z', externalId: 'OU=Contoso' };
    renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs }), { auth: { authFetch: api() } });
    const details = await screen.findByRole('region', { name: 'More details' });
    expect([...details.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['Last updated', 'External Id']);
    expect(within(details).getByText('Last updated').nextElementSibling.textContent).not.toMatch(/T12:06/);
  });

  it('an analyst also gets the raw classification and flags', async () => {
    const attrs = { ...PEOPLE, variant: 'synced', contextType: 'Department', userRenamed: false };
    renderWithProviders(h(ContextProfile, { profile: PROFILES.OrganizationalUnit, attrs, analyst: true }), { auth: { authFetch: api() } });
    const details = await screen.findByRole('region', { name: 'More details' });
    expect(within(details).getByText('Variant').nextElementSibling).toHaveTextContent('synced');
    expect(within(details).getByText('Context Type').nextElementSibling).toHaveTextContent('Department');
    expect(within(details).getByText('User Renamed').nextElementSibling).toHaveTextContent('No');
  });

  it('lists what the facts do not show under More details, and not the member counts they do', async () => {
    mount({ attrs: { ...PEOPLE, externalId: 'OU=Contoso', lastSyncedAt: '2026-10-01T08:00:00Z', extendedAttributes: { costCenter: 'CC-12' } } });
    const details = await screen.findByRole('region', { name: 'More details' });
    // It sits inside the facts card, after the facts.
    expect(facts('About this unit')).toContainElement(details);
    expect(within(details).getByText('External Id').nextElementSibling).toHaveTextContent('OU=Contoso');
    expect(within(details).getByText('Last Synced At')).toBeInTheDocument();
    expect(within(details).getByText('costCenter').nextElementSibling).toHaveTextContent('CC-12');
    // The facts show both counts, so neither is repeated here.
    expect(within(details).queryByText('Total Member Count')).toBeNull();
    expect(within(details).queryByText('Direct Member Count')).toBeNull();
    expect(within(details).queryByText('Display Name')).toBeNull();
  });
});

describe('ContextProfile — logical application', () => {
  const APP = { id: 'c-app', displayName: 'SAP', contextCategory: 'LogicalApplication', targetType: 'Resource', totalMemberCount: 31 };

  it('calls the Accountable its Owner and counts its resources', async () => {
    const { user } = mount({ profile: PROFILES.LogicalApplication, attrs: APP, links: [], roles: [{ id: 'r', role: 'Accountable', principalId: 'p-1', displayName: 'Ann Owner', addedBy: 'analyst' }] });
    const region = facts('About this application');
    expect(await within(region).findByText('Ann Owner')).toBeInTheDocument();
    expect(within(region).getByRole('group', { name: 'Owner' })).toHaveTextContent('Answers for who may access this application');
    // The pencil and its modal use the same word.
    await user.click(within(region).getByRole('button', { name: 'Edit Owner' }));
    expect(screen.getByRole('heading', { name: 'Set Owner' })).toBeInTheDocument();
    expect(within(region).queryByText(/Accountable|this unit/)).toBeNull();
    expect(fact(region, 'Resources')).toHaveTextContent(/^31$/);
    expect(within(region).queryByText('Sub-units')).toBeNull();
  });

  it('shows no variants section when it has none', async () => {
    mount({ profile: PROFILES.LogicalApplication, attrs: APP, links: [] });
    await screen.findByText('About this application');
    expect(screen.queryByTestId('unit-variants')).toBeNull();
  });

  it('lists its variants when it has any (rare)', async () => {
    const links = [{ ...LINKS[0], relatedTotalMemberCount: 3 }];
    mount({ profile: PROFILES.LogicalApplication, attrs: APP, links });
    expect(await screen.findByRole('button', { name: 'Accounts 3' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'This application as' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resources 31' })).toHaveAttribute('aria-pressed', 'true');
  });
});
