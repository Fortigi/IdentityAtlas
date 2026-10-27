// @vitest-environment jsdom
// What we know holds the facts about the unit itself: its other names (proposed
// ones dashed, confirmed inline), the same unit held as other kinds of member
// (the variants switch), and the remaining attributes (More details). Invented
// names throughout.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ClaimsProvider from './ClaimsProvider';
import WhatWeKnow from './WhatWeKnow';
import { PROFILES } from '@ui/components/contexts/profiles/profiles';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const READER = { hasWildcard: false, permissions: new Set(['data.read']) };
const SRC = { interviewId: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.txt', proposedBy: 'model' };
const PEOPLE = {
  id: 'c-ppl', displayName: 'Contoso', contextCategory: 'OrganizationalUnit', targetType: 'Identity', variant: 'synced', contextType: 'Department',
  directMemberCount: 4, totalMemberCount: 12, externalId: 'OU=Contoso', extendedAttributes: { aliases: ['HO'], costCenter: 'CC-12' },
};
const LINKS = [
  { id: 'l1', relationshipType: 'SameUnitAs', relatedContextId: 'c-acc', relatedDisplayName: 'Contoso', relatedTargetType: 'Principal', direction: 'out' },
  { id: 'l2', relationshipType: 'SameUnitAs', relatedContextId: 'c-res', relatedDisplayName: 'Contoso', relatedTargetType: 'Resource', direction: 'in', relatedTotalMemberCount: 31 },
];
const ALIASES = [
  { id: 'a-haven', claimKind: 'alias', status: 'proposed', value: 'Havenkantoor', quote: 'Het Havenkantoor is al lang klant.', ...SRC },
  { id: 'a-kade', claimKind: 'alias', status: 'proposed', value: 'Kade', quote: 'De Kade', ...SRC },
];

function mount({ attrs = PEOPLE, links = LINKS, claims = ALIASES, auth = {}, profile = PROFILES.OrganizationalUnit, analyst = true } = {}) {
  const state = { claims: claims.map(c => ({ ...c })), patches: [] };
  const onOpenDetail = vi.fn();
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const patch = /^\/api\/contexts\/claims\/([^/]+)$/.exec(u);
    if (patch && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      state.patches.push({ id: patch[1], body });
      state.claims.find(c => c.id === patch[1]).status = body.status;
      return { claim: {}, effect: { kind: 'alias' } };
    }
    if (u === `/api/contexts/${attrs.id}/claims`) return { data: state.claims, accountableDoubt: null, contradictions: [] };
    if (u === `/api/contexts/${attrs.id}/interviews`) return { data: [] };
    if (u === `/api/contexts/${attrs.id}/relationships`) return links;
    if (u === '/api/contexts/c-acc') return { attributes: { id: 'c-acc', totalMemberCount: 15 } };
    return jsonResponse({}, { ok: false, status: 500 });
  });
  renderWithProviders(h(ClaimsProvider, { contextId: attrs.id }, h(WhatWeKnow, { attrs, profile, analyst, onOpenDetail })), { auth: { authFetch, ...auth } });
  return { state, authFetch, onOpenDetail, user: userEvent.setup() };
}

async function open(user) {
  const region = await screen.findByRole('region', { name: 'What we know' });
  await user.click(within(region).getByRole('button', { name: /^What we know/ }));
  return region;
}

describe('Also known as', () => {
  it('confirmed names solid, the proposals dashed with their quote and Confirm / Reject', async () => {
    const { user } = mount();
    await open(user);
    const list = await screen.findByRole('list', { name: 'Also known as' });
    expect(within(list).getAllByTestId('alias-confirmed').map(li => li.textContent)).toEqual(['HO']);
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed')).toHaveLength(2));
    const proposed = within(list).getAllByTestId('alias-proposed')[0].querySelector('span');
    expect(proposed.className).toContain('border-dashed');
    expect(proposed).toHaveAttribute('title', 'Proposed — “Het Havenkantoor is al lang klant.” — interview with Anna Voorbeeld, 2026-10-01');
  });

  it('Confirm and Reject decide the claim; the list follows', async () => {
    const { state, user } = mount();
    await open(user);
    const list = await screen.findByRole('list', { name: 'Also known as' });
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed')).toHaveLength(2));
    await user.click(within(list).getByRole('button', { name: 'Reject “Kade”' }));
    await waitFor(() => expect(within(list).getAllByTestId('alias-proposed').map(li => li.textContent)).toEqual(['HavenkantoorConfirmReject']));
    await user.click(within(list).getByRole('button', { name: 'Confirm “Havenkantoor” as another name' }));
    expect(state.patches).toEqual([{ id: 'a-kade', body: { status: 'rejected' } }, { id: 'a-haven', body: { status: 'confirmed' } }]);
    await waitFor(() => expect(within(list).getAllByTestId('alias-confirmed').map(li => li.textContent)).toEqual(['HO', 'Havenkantoor']));
  });

  it('a reader sees the confirmed names only, without buttons; the summary names them', async () => {
    const { user } = mount({ auth: READER, claims: [] });
    const region = await open(user);
    expect(within(region).getByTestId('what-we-know-summary')).toHaveTextContent(/^also known as HO$/);
    const list = await screen.findByRole('list', { name: 'Also known as' });
    expect(within(list).queryByTestId('alias-proposed')).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
  });
});

describe('the unit held as other kinds of member', () => {
  it('switches between the variants, each with its member count; pressing this one opens nothing', async () => {
    const { onOpenDetail, user, authFetch } = mount();
    await open(user);
    const group = await screen.findByRole('group', { name: 'This unit as' });
    await within(group).findByRole('button', { name: 'Accounts 15' });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['People 12', 'Accounts 15', 'Resources 31']);
    expect(within(group).getByRole('button', { name: 'People 12' })).toHaveAttribute('aria-pressed', 'true');
    // Only the link without a count was read; the members were never merged.
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-acc');
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/c-res');
    await user.click(within(group).getByRole('button', { name: 'Accounts 15' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c-acc', 'Contoso');
    onOpenDetail.mockClear();
    await user.click(within(group).getByRole('button', { name: 'People 12' }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('an application names them its way; one kind only leaves the switch out', async () => {
    const app = { id: 'c-app', displayName: 'SAP', contextCategory: 'LogicalApplication', targetType: 'Resource', totalMemberCount: 31 };
    const { user, authFetch } = mount({ attrs: app, profile: PROFILES.LogicalApplication, links: [{ ...LINKS[0], relatedTotalMemberCount: 3 }] });
    await open(user);
    expect(await screen.findByRole('group', { name: 'This application as' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resources 31' })).toHaveAttribute('aria-pressed', 'true');
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/c-acc');
  });

  it('leaves the switch out for a unit held as one kind only', async () => {
    const { user, authFetch } = mount({ links: [] });
    await open(user);
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/c-ppl/relationships'));
    expect(screen.queryByTestId('unit-variants')).toBeNull();
  });
});

describe('More details', () => {
  it('an analyst gets the remaining attributes with the raw classification, inside What we know', async () => {
    const { user } = mount();
    const region = await open(user);
    const details = within(region).getByRole('region', { name: 'More details' });
    expect(within(details).getByText('External Id').nextElementSibling).toHaveTextContent('OU=Contoso');
    expect(within(details).getByText('costCenter').nextElementSibling).toHaveTextContent('CC-12');
    expect(within(details).getByText('Variant').nextElementSibling).toHaveTextContent('synced');
    expect(within(details).queryByText('Display Name')).toBeNull();
    expect(within(details).queryByText('Also known as')).toBeNull();
  });

  it('a business reader gets them without the raw classification', async () => {
    const { user } = mount({ auth: READER, claims: [], analyst: false });
    const region = await open(user);
    const details = within(region).getByRole('region', { name: 'More details' });
    expect(within(details).getByText('External Id')).toBeInTheDocument();
    expect(within(details).queryByText('Variant')).toBeNull();
    expect(within(details).queryByText('Context Type')).toBeNull();
  });
});

describe('What we know — what the unit\'s people do, know and hold', () => {
  const KNOW = [
    { id: 'k1', claimKind: 'activity', status: 'confirmed', principalId: 'p-1', subjectDisplayName: 'Piet Proef', value: 'Handle claims', objectName: 'Handle property claims', filedUnderName: 'Claims Handling', quote: 'Piet handles the property claims.', ...SRC },
    { id: 'k2', claimKind: 'duty', status: 'confirmed', principalId: 'p-2', subjectDisplayName: 'Yara Test', value: 'Works council member', filedUnderName: 'Contoso', ...SRC },
    { id: 'k3', claimKind: 'expertise', status: 'proposed', principalId: 'p-2', subjectDisplayName: 'Yara Test', value: 'Subrogation', filedUnderName: 'Claims Handling', quote: 'Yara knows subrogation.', ...SRC },
  ];

  it('counts them in the folded line and lists them by kind with person, name and where the source was added', async () => {
    const { user } = mount({ claims: KNOW, links: [] });
    const region = await screen.findByRole('region', { name: 'What we know' });
    await waitFor(() => expect(region).toHaveTextContent('1 activity · 1 duty · 1 to review'));
    await open(user);
    const list = within(region).getByTestId('people-knowledge');
    expect(list).toHaveTextContent('What its people do, know and hold · 1 activity · 1 duty');
    const activity = within(list).getByLabelText('Activity: Piet Proef — Handle property claims');
    expect(activity).toHaveTextContent('added on Claims Handling');
    expect(activity).toHaveTextContent('interview with Anna Voorbeeld, 2026-10-01');
    // Filed on this unit itself: no "added on".
    expect(within(list).getByLabelText('Duty: Yara Test — Works council member')).not.toHaveTextContent('added on');
    // The proposed one is not a fact yet: it waits in the review list.
    expect(within(list).queryByText('Subrogation')).toBeNull();
    expect(within(region).getByText(/Yara knows subrogation/)).toBeInTheDocument();
  });

  it('shows nothing of the kind when no such claim is confirmed', async () => {
    const { user } = mount({ claims: [KNOW[2]], links: [], auth: READER });
    const region = await open(user);
    expect(within(region).queryByTestId('people-knowledge')).toBeNull();
  });
});
