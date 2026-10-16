// @vitest-environment jsdom
//
// The match table is where the analyst checks the result before saving: what is in, what
// was kept out, what a dropped term would add — and why each object is there.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatchesPanel from './MatchesPanel';
import { renderWithProviders, makeAuthFetch, screen, fireEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';

const FIELD_LABELS = { displayName: 'Name', description: 'Description', mail: 'Mail address' };
const RECIPE = { name: 'Inkoop', resourceTypes: ['Group'], fields: ['displayName'], terms: [], include: [], exclude: [], structure: 'byTerm' };

const match = (id, displayName, status, hits = []) => ({
  id, displayName, status, hits, description: null, resourceType: 'Group', systemName: 'EntraID',
});

const EVALUATION = {
  scopeTotal: 158,
  memberCount: 2,
  matches: [
    match('g1', 'SG_Inkoop_Users', 'member', [{ term: 'inkoop', fields: ['displayName'], accepted: true }]),
    match('g2', 'Coupa Admins', 'included'),
    match('g3', 'Zorg Planning', 'excluded', [{ term: 'zorg', fields: ['displayName'], accepted: true }]),
    match('g4', 'Order Intake', 'candidate', [{ term: 'order', fields: ['description'], accepted: false }]),
  ],
};

function mount({ evaluation = EVALUATION, recipe = RECIPE, lookup = [] } = {}) {
  const onChoose = vi.fn();
  const onChooseOrg = vi.fn();
  const onChoosePrincipal = vi.fn();
  const onOpenDetail = vi.fn();
  const authFetch = makeAuthFetch({ '/lookup': { data: lookup } });
  renderWithProviders(
    h(MatchesPanel, { evaluation, recipe, fieldLabels: FIELD_LABELS, onChoose, onChooseOrg, onChoosePrincipal, onOpenDetail }),
    { auth: { authFetch } },
  );
  return { onChoose, onChooseOrg, onChoosePrincipal, onOpenDetail, authFetch };
}

describe('MatchesPanel', () => {
  it('opens on what is in the context, counts each view, and says how big the scope is', () => {
    mount();
    expect(screen.getByRole('tab', { name: 'In the context (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Excluded (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Found only by dropped terms (1)' })).toBeInTheDocument();
    expect(screen.getByText('of 158 group objects in scope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SG_Inkoop_Users' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zorg Planning' })).toBeNull();
  });

  it('shows why an object is in it: the term that found it, and the field when it was not the name', () => {
    mount();
    expect(screen.getByText('inkoop')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Found only by dropped terms (1)' }));
    expect(screen.getByText('order (description)')).toBeInTheDocument();
  });

  it('offers the opposite action per row, and reports the analyst\'s choice', () => {
    const { onChoose } = mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Exclude' })[0]);
    expect(onChoose).toHaveBeenCalledWith('g1', 'exclude');

    // An object added by hand is removed again, not excluded.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChoose).toHaveBeenCalledWith('g2', 'auto');

    fireEvent.click(screen.getByRole('tab', { name: 'Excluded (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
    expect(onChoose).toHaveBeenCalledWith('g3', 'auto');
  });

  it('opens the object itself when its name is clicked', () => {
    const { onOpenDetail } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'SG_Inkoop_Users' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'SG_Inkoop_Users');
  });

  it('includes an object by name, and offers only kinds the context searches', async () => {
    const { onChoose, authFetch } = mount({ lookup: [
      { id: 'g9', name: 'Ariba Approvers', type: 'Group' },
      { id: 'a1', name: 'Ariba App Role', type: 'AppRole' },   // out of scope
    ] });
    fireEvent.change(screen.getByLabelText('Find an object to include by hand'), { target: { value: 'ariba' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    await waitFor(() => expect(screen.getByText('Ariba Approvers')).toBeInTheDocument());
    // A resource lookup is asked exactly as before users recipes existed: no kind.
    expect(authFetch).toHaveBeenCalledWith('/api/context-assistant/lookup?q=ariba');
    expect(screen.queryByText('Ariba App Role')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    expect(onChoose).toHaveBeenCalledWith('g9', 'include');
  });

  it('says when a view is empty, and when there was more than it could show', () => {
    mount({ evaluation: { ...EVALUATION, matches: [], truncated: true } });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
    expect(screen.getByText(/More objects matched than can be shown/)).toBeInTheDocument();
  });
});

// A users recipe: the resources stay as they are, and two blocks follow — the organisation
// entities the terms find, and the users both lead to, each with why it is there.
const USERS_RECIPE = {
  ...RECIPE, target: 'principal', access: { assignmentTypes: ['Direct', 'Indirect'] },
  orgInclude: [], orgExclude: [], principalInclude: ['u3'], principalExclude: ['u8', 'u9'],
};
const USERS_EVALUATION = {
  ...EVALUATION,
  target: 'principal',
  orgMatches: [
    { id: 'o1', entityType: 'Klant', label: 'Contoso', termKeys: ['contoso'], linkedPrincipals: 4, state: 'matched' },
    { id: 'o2', entityType: 'Project', label: 'Contoso Migration', termKeys: ['contoso'], linkedPrincipals: 1, state: 'excluded' },
  ],
  principals: {
    total: 250,
    sample: [
      { id: 'u1', displayName: 'Ann Example', upn: 'ann@contoso.example', principalType: 'User', via: [
        { kind: 'access', resourceId: 'g1', label: 'SG_Inkoop_Users', assignmentType: 'Direct' },
        { kind: 'org', entityId: 'o1', label: 'Contoso', entityType: 'Klant' },
      ] },
      { id: 'u3', displayName: 'Bob Northwind', upn: null, principalType: 'ServicePrincipal', via: [] },
    ],
  },
  termPrincipals: { contoso: 5 },
};

describe('MatchesPanel — users with access', () => {
  it('a resource recipe shows no organisation or users blocks', () => {
    mount();
    expect(screen.queryByRole('region', { name: 'Matched organisation entities' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resulting users' })).toBeNull();
  });

  it('shows the resources as today, then the organisation entities and the users', () => {
    mount({ evaluation: USERS_EVALUATION, recipe: USERS_RECIPE });
    const resources = screen.getByRole('region', { name: 'Matched resources' });
    expect(within(resources).getByRole('button', { name: 'SG_Inkoop_Users' })).toBeInTheDocument();
    expect(within(resources).getByRole('tab', { name: 'In the context (2)' })).toBeInTheDocument();

    const orgs = screen.getByRole('region', { name: 'Matched organisation entities' });
    expect(within(orgs).getByText('1 of 2 kept; the users linked to them (owner, team, activity) join the context.')).toBeInTheDocument();
    expect(within(orgs).getByText('4 users')).toBeInTheDocument();
    expect(within(orgs).getByText('1 user')).toBeInTheDocument();

    const users = screen.getByRole('region', { name: 'Resulting users' });
    expect(within(users).getByRole('heading', { name: 'Users in the context — 250 users' })).toBeInTheDocument();
    expect(within(users).getByText('Showing 2 of 250, by name.')).toBeInTheDocument();
  });

  it('labels each user with why it is in the context', () => {
    mount({ evaluation: USERS_EVALUATION, recipe: USERS_RECIPE });
    const ann = screen.getByRole('button', { name: 'Ann Example' }).closest('tr');
    expect(within(ann).getByText('member of SG_Inkoop_Users')).toBeInTheDocument();
    expect(within(ann).getByText('Klant Contoso')).toBeInTheDocument();
    expect(within(ann).getByText('ann@contoso.example')).toBeInTheDocument();
    const bob = screen.getByRole('button', { name: 'Bob Northwind' }).closest('tr');
    expect(within(bob).getByText('added by hand')).toBeInTheDocument();
    expect(within(bob).getByText('ServicePrincipal')).toBeInTheDocument();
  });

  it('an organisation entity is excluded or put back through the org list, not the resource list', () => {
    const { onChoose, onChooseOrg, onOpenDetail } = mount({ evaluation: USERS_EVALUATION, recipe: USERS_RECIPE });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Contoso' }));
    expect(onChooseOrg).toHaveBeenCalledWith('o1', 'exclude');
    fireEvent.click(screen.getByRole('button', { name: 'Put back Contoso Migration' }));
    expect(onChooseOrg).toHaveBeenCalledWith('o2', 'auto');
    expect(onChoose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'o1', 'Contoso');
  });

  it('a user is excluded, a hand-added one removed, and the removed ones put back — all through the user list', () => {
    const { onChoosePrincipal, onChooseOrg, onOpenDetail } = mount({ evaluation: USERS_EVALUATION, recipe: USERS_RECIPE });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude Ann Example' }));
    expect(onChoosePrincipal).toHaveBeenLastCalledWith('u1', 'exclude');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob Northwind' }));
    expect(onChoosePrincipal).toHaveBeenLastCalledWith('u3', 'auto');

    expect(screen.getByText('2 removed by hand')).toBeInTheDocument();
    onChoosePrincipal.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Put them back' }));
    expect(onChoosePrincipal.mock.calls).toEqual([['u8', 'auto'], ['u9', 'auto']]);
    expect(onChooseOrg).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ann Example' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'Ann Example');
  });

  it('adds a user by hand through the principal lookup', async () => {
    const { onChoosePrincipal, onChoose, authFetch } = mount({
      evaluation: USERS_EVALUATION, recipe: USERS_RECIPE,
      lookup: [{ id: 'u7', name: 'Carol Example', type: 'User', upn: 'carol@northwind.example' }, { id: 'u3', name: 'Bob Northwind', type: 'User' }],
    });
    const users = screen.getByRole('region', { name: 'Resulting users' });
    fireEvent.change(within(users).getByRole('textbox', { name: 'Find a user to add by hand' }), { target: { value: 'example' } });
    fireEvent.click(within(users).getByRole('button', { name: 'Find' }));

    await waitFor(() => expect(screen.getByText('Carol Example')).toBeInTheDocument());
    expect(authFetch).toHaveBeenCalledWith('/api/context-assistant/lookup?kind=principal&q=example');
    expect(screen.getByText('User · carol@northwind.example')).toBeInTheDocument();

    // Bob is already added by hand, so only Carol offers Include.
    expect(within(users).getAllByRole('button', { name: 'Include' })).toHaveLength(1);
    fireEvent.click(within(users).getByRole('button', { name: 'Include' }));
    expect(onChoosePrincipal).toHaveBeenCalledWith('u7', 'include');
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('says so when no user is reached yet', () => {
    mount({ evaluation: { ...USERS_EVALUATION, orgMatches: [], principals: { total: 0, sample: [] } }, recipe: { ...USERS_RECIPE, principalExclude: [] } });
    expect(screen.getByRole('heading', { name: 'Users in the context — 0 users' })).toBeInTheDocument();
    expect(screen.queryByText(/removed by hand/)).toBeNull();
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });
});
