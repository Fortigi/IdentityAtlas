// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AccessPackageDetailPage from '@ui/components/AccessPackageDetailPage';
import BusinessRoleMembers from './BusinessRoleMembers';
import { countByWay, filterMembers, MEMBER_PAGE_SIZE } from './accessModel';
import BusinessRoleResources from './BusinessRoleResources';
import BusinessRoleOwnerImport from './BusinessRoleOwnerImport';
import WayChips from './WayChips';
import BusinessRoleLifecycle from './BusinessRoleLifecycle';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const ID = 'br-1';
const BASE = `/api/access-package/${ID}`;

const RULE_POLICY = {
  id: 'p1', displayName: 'Everyone in IT', hasAutoAddRule: true, hasAutoRemoveRule: true, hasAccessReview: false,
  targetRule: '(user.department -eq "IT")', holderCount: 12,
};
const REQUEST_POLICY = {
  id: 'p2', displayName: 'Request it', hasAutoAddRule: false, hasAutoRemoveRule: true, hasAccessReview: true, allowsRequest: true,
  requiresApproval: true, hasExpiration: true, expiration: { type: 'afterDuration', duration: 'P90D' }, holderCount: 1,
  reviewSettings: { isEnabled: true, schedule: { recurrence: { pattern: { type: 'absoluteMonthly', interval: 3 } } } },
};

const role = (over = {}) => ({
  attributes: { id: ID, displayName: 'Finance Access' },
  accessModel: { waysIn: ['Rule', 'Request'], waysOut: ['Rule', 'Review', 'Expiry'], control: 'Manual', reviewRequired: true, reviewGap: false },
  automaticHolderCount: 12,
  assignmentCount: 13, groupCount: 2, pendingRequestCount: 1, reviewCount: 4,
  ...over,
});

const MEMBERS = [
  { principalId: 'u1', targetDisplayName: 'Ann Rule', targetUPN: 'ann@example.test', howHeld: ['Rule'], via: [{ displayName: 'Everyone in IT' }] },
  { principalId: 'u2', targetDisplayName: 'Bo Request', targetUPN: 'bo@example.test', howHeld: ['Request'], via: [{ displayName: 'Request it' }], expirationDateTime: '2027-01-15T00:00:00Z' },
  { principalId: 'u3', targetDisplayName: 'Cy Both', targetUPN: 'cy@example.test', howHeld: ['Rule', 'Request'], via: [{ displayName: 'Everyone in IT' }, { displayName: 'Request it' }] },
];
const RESOURCES = [
  { childResourceId: 'g1', resourceDisplayName: 'SG-Finance', resourceType: 'Group', roleName: 'Member' },
  { childResourceId: 'g2', resourceDisplayName: 'Old group', resourceType: 'Group', roleName: 'Owner', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
];

function api({ body = role(), policies = [RULE_POLICY, REQUEST_POLICY], members = MEMBERS, resources = RESOURCES, participants = PARTICIPANTS } = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/api/risk-scores/')) return jsonResponse(null, { ok: false, status: 404 });
    if (u === `${BASE}/owners`) return [];
    if (u === `${BASE}/owners/suggestions`) return {};
    if (u === `${BASE}/participants`) return participants;
    if (u === `${BASE}/policies`) return policies;
    if (u === `${BASE}/assignments`) return members;
    if (u === `${BASE}/resource-roles`) return resources;
    if (u === `${BASE}/reviews` || u === `${BASE}/requests`) return [];
    if (u === `${BASE}/composition-reviews`) return { reviews: [], current: { type: { control: 'Manual' }, resources: [{ id: 'g1' }, { id: 'g2' }] }, latestSignOff: null };
    if (u === BASE) return body;
    return undefined;
  });
}

const PARTICIPANTS = [
  { participation: 'Approver', subjectType: 'User', principalId: 'u9', displayName: 'Carla Cash', stage: 1 },
  { participation: 'Approver', subjectType: 'Manager', managerLevel: 1, stage: 2 },
  { participation: 'Reviewer', subjectType: 'User', principalId: 'u8', displayName: 'Rita Review', isFallback: true },
  { participation: 'Requestor', subjectType: 'Group', groupId: 'g7', displayName: 'SG-Sales', contextId: 'c1', contextName: 'Sales team' },
  { participation: 'Requestor', subjectType: 'Rule', rule: '(user.jobTitle -eq "x")' },
];

function mountPage(opts, wrap = (el) => el) {
  const onOpenDetail = vi.fn();
  renderWithProviders(wrap(h(AccessPackageDetailPage, { accessPackageId: ID, onClose: () => {}, onOpenDetail })), { auth: { authFetch: api(opts) } });
  return { onOpenDetail, user: userEvent.setup() };
}

const openLifecycle = async (user) => user.click(await screen.findByRole('tab', { name: 'Lifecycle' }));

describe('the business role page', () => {
  it('opens on a calm Overview: the type by the name, the rest on Lifecycle', async () => {
    mountPage();
    expect(await screen.findByTestId('role-type')).toHaveTextContent(/^Manual$/);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Who answers for this role')).toBeInTheDocument();
    expect(screen.queryByText('Gained by')).toBeNull();
    expect(screen.queryByText('Getting it')).toBeNull();
    expect(screen.queryByText('(user.department -eq "IT")')).toBeNull();
  });

  it('offers Requests & reviews for a requestable role', async () => {
    mountPage();
    expect(await screen.findByRole('tab', { name: /Requests & reviews/ })).toBeInTheDocument();
  });

  it('leaves Requests & reviews out for a purely rule-based role', async () => {
    mountPage({ body: role({ accessModel: { waysIn: ['Rule'], waysOut: ['Rule'] }, pendingRequestCount: 0, reviewCount: 0 }) });
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: /Requests/ })).toBeNull();
  });

  it('warns on the Overview when the last review was missed, and links to Lifecycle', async () => {
    const { user } = mountPage({ body: role({ complianceStatus: 'Missed', daysOverdue: 21 }) });
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('The last review of this role was missed: it was due 21 days ago.');
    await user.click(within(warning).getByRole('button', { name: 'See the details on Lifecycle' }));
    expect(screen.getByRole('tab', { name: 'Lifecycle' })).toHaveAttribute('aria-selected', 'true');
  });

  it('warns on the Overview when a manual role has no review set up', async () => {
    mountPage({ body: role({ accessModel: { waysIn: ['Request'], waysOut: [], control: 'Manual', reviewRequired: true, reviewGap: true } }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('no regular review is set up');
  });

  it('shows no warning when the reviews are in order', async () => {
    mountPage({ body: role({ complianceStatus: 'Compliant' }) });
    await screen.findByRole('button', { name: /13\s*People/ });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('jumps to People from the count on the Overview', async () => {
    const { user } = mountPage();
    await user.click(await screen.findByRole('button', { name: /13\s*People/ }));
    expect(await screen.findByText('Ann Rule')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /People/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to Resources from the count on the Overview', async () => {
    const { user } = mountPage();
    await user.click(await screen.findByRole('button', { name: /2\s*Resources/ }));
    expect(await screen.findByText('SG-Finance')).toBeInTheDocument();
  });

  it('opens Requests & reviews without repeating the policies', async () => {
    const { user } = mountPage();
    await user.click(await screen.findByRole('tab', { name: /Requests & reviews/ }));
    expect(await screen.findByText('Pending Requests')).toBeInTheDocument();
    expect(screen.queryByText('Assignment Policies')).toBeNull();
  });

  it('falls back to Attributes in a share view, which has no Overview', async () => {
    mountPage(undefined, (el) => h(SharedViewContext.Provider, { value: true }, el));
    const tab = await screen.findByRole('tab', { name: /Attributes/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Lifecycle' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Composition review' })).toBeNull();
  });

  it('opens the composition review from its own tab, after Lifecycle', async () => {
    const { user } = mountPage();
    const tabs = (await screen.findAllByRole('tab')).map(t => t.textContent);
    expect(tabs.indexOf('Composition review')).toBe(tabs.indexOf('Lifecycle') + 1);
    await user.click(screen.getByRole('tab', { name: 'Composition review' }));
    expect(await screen.findByText('Nobody has signed off what this role contains yet.')).toBeInTheDocument();
  });
});

describe('BusinessRoleLifecycle', () => {
  const mount = (opts = {}, data = role()) => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(BusinessRoleLifecycle, { roleId: ID, data, onOpenDetail }), { auth: { authFetch: api(opts) } });
    return { onOpenDetail, user: userEvent.setup() };
  };
  const stage = async (title) => (await screen.findByRole('heading', { name: title })).closest('section');

  it('says how much of a Manual role a review has to cover', async () => {
    mount();
    const summary = await screen.findByTestId('role-control');
    expect(summary).toHaveTextContent('1 person holds it without a rule');
    expect(summary).not.toHaveTextContent('No access review');
  });

  it('warns when a Manual role has no review', async () => {
    mount({}, role({ accessModel: { waysIn: ['Request'], waysOut: [], control: 'Manual', reviewGap: true } }));
    expect(await within(await screen.findByTestId('role-control')).findByRole('status')).toHaveTextContent('No access review');
  });

  it('states that a rule-only role needs no review', async () => {
    mount({}, role({ accessModel: { waysIn: ['Rule'], waysOut: ['Rule'], control: 'Automatic', reviewGap: false } }));
    expect(await screen.findByTestId('role-control')).toHaveTextContent('nobody has to review');
  });

  it('puts the request scope, approvers and approval under Getting it', async () => {
    mount();
    const getting = await stage('Getting it');
    expect(within(getting).getByText('Who can request it')).toBeInTheDocument();
    expect(within(getting).getByRole('button', { name: 'SG-Sales' })).toBeInTheDocument();
    expect(within(getting).getByText('(user.jobTitle -eq "x")')).toBeInTheDocument();
    expect(within(getting).getByRole('button', { name: 'Carla Cash' })).toBeInTheDocument();
    expect(within(getting).getByText("The person's manager")).toBeInTheDocument();
    expect(within(getting).getByText('stage 2')).toBeInTheDocument();
    expect(within(getting).getByText('Requests need approval')).toBeInTheDocument();
    expect(within(getting).getByText('(user.department -eq "IT")')).toBeInTheDocument();
  });

  it('puts the cadence, reviewers and last review under Keeping it', async () => {
    mount({}, role({ complianceStatus: 'Missed', daysOverdue: 5, lastReviewDate: '2026-03-01T00:00:00Z', lastReviewedBy: 'auditor' }));
    const keeping = await stage('Keeping it');
    expect(within(keeping).getByText('Access review: recurs every 3 months')).toBeInTheDocument();
    expect(within(keeping).getByRole('button', { name: 'Rita Review' })).toBeInTheDocument();
    expect(within(keeping).getByText('fallback')).toBeInTheDocument();
    expect(within(keeping).getByText('Missed (5d ago)')).toBeInTheDocument();
    expect(within(keeping).getByText(/by auditor/)).toBeInTheDocument();
  });

  it('puts the expiry and the removal rule under Losing it', async () => {
    mount();
    const losing = await stage('Losing it');
    expect(within(losing).getByText('Removal rule')).toBeInTheDocument();
    expect(within(losing).getByText('Ends after 90 days')).toBeInTheDocument();
    expect(within(losing).getByText('(user.department -eq "IT")')).toBeInTheDocument();
  });

  it('explains a removal rule that has no rule text', async () => {
    mount({ policies: [{ ...REQUEST_POLICY, targetRule: null, hasAccessReview: false }] });
    expect(within(await stage('Losing it')).getByText(/leaves the people this policy allows/)).toBeInTheDocument();
  });

  it('says when nothing keeps the role in check', async () => {
    mount({ policies: [RULE_POLICY], participants: [] });
    expect(within(await stage('Keeping it')).getByText('No regular review.')).toBeInTheDocument();
  });

  it('keeps the policy detail folded, with the people per policy', async () => {
    mount();
    const summary = await screen.findByText('Policies (2)');
    const details = summary.closest('details');
    expect(details.open).toBe(false);
    const rows = within(details).getAllByTestId('role-policy');
    expect(rows[0]).toHaveTextContent('Everyone in IT');
    expect(rows[0]).toHaveTextContent('12 people');
    expect(rows[0]).toHaveTextContent('Added and removed by this rule');
    expect(rows[1]).toHaveTextContent('1 person');
  });

  it('shows no empty "gained by" on a removal-only policy', async () => {
    mount({ policies: [{ id: 'p9', displayName: 'Auto Remove', hasAutoRemoveRule: true, targetRule: 'x', holderCount: 0 }] });
    const row = within((await screen.findByText('Policies (1)')).closest('details')).getByTestId('role-policy');
    expect(row).not.toHaveTextContent('Gained by');
    expect(row).not.toHaveTextContent('Unknown');
    expect(row).toHaveTextContent('Lost by');
  });

  it('says so when the source delivers no policies', async () => {
    mount({ policies: [] }, role({ accessModel: { waysIn: ['Unknown'], waysOut: ['Unknown'], control: 'Unknown' } }));
    expect(await screen.findByText(/delivers no assignment policies/)).toBeInTheDocument();
  });

  it('opens the person, the group and the matched context', async () => {
    const { onOpenDetail, user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Carla Cash' }));
    await user.click(screen.getByRole('button', { name: 'SG-Sales' }));
    await user.click(screen.getByRole('button', { name: 'Sales team' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u9', 'Carla Cash');
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g7', 'SG-Sales');
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'c1', 'Sales team');
  });

  it('shows a load failure', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'x' }, { ok: false, status: 500 }));
    renderWithProviders(h(BusinessRoleLifecycle, { roleId: ID, data: role() }), { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  });

  it('is reachable from its tab on the page', async () => {
    const { user } = mountPage();
    await openLifecycle(user);
    expect(await screen.findByRole('heading', { name: 'Losing it' })).toBeInTheDocument();
  });
});

describe('People who need a review', () => {
  const rows = [
    { principalId: 'u1', targetDisplayName: 'Ann Rule', howHeld: ['Rule'], automatic: true },
    { principalId: 'u2', targetDisplayName: 'Bo Request', howHeld: ['Request'], automatic: false },
  ];

  it('marks and filters them on a Manual role', async () => {
    renderWithProviders(h(BusinessRoleMembers, { roleId: ID, control: 'Manual' }), { auth: { authFetch: api({ members: rows }) } });
    const user = userEvent.setup();
    const bo = (await screen.findByText('Bo Request')).closest('tr');
    expect(within(bo).getByText('needs review')).toBeInTheDocument();
    expect(within(screen.getByText('Ann Rule').closest('tr')).queryByText('needs review')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Needs review (1)' }));
    expect(screen.queryByText('Ann Rule')).toBeNull();
  });

  it('marks nobody on a rule-only role', async () => {
    renderWithProviders(h(BusinessRoleMembers, { roleId: ID, control: 'Automatic' }), { auth: { authFetch: api({ members: rows }) } });
    await screen.findByText('Bo Request');
    expect(screen.queryByText('needs review')).toBeNull();
    expect(screen.queryByRole('button', { name: /Needs review/ })).toBeNull();
  });
});

describe('BusinessRoleResources', () => {
  it('lists the resources with their role and opens one', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(BusinessRoleResources, { roleId: ID, onOpenDetail }), { auth: { authFetch: api() } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'SG-Finance' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'SG-Finance');
    expect(screen.getByText('Deleted in source')).toBeInTheDocument();
  });

  it('says when the role contains nothing', async () => {
    renderWithProviders(h(BusinessRoleResources, { roleId: ID }), { auth: { authFetch: api({ resources: [] }) } });
    expect(await screen.findByText('This role contains no resources.')).toBeInTheDocument();
  });

  it('shows a load failure', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'x' }, { ok: false, status: 500 }));
    renderWithProviders(h(BusinessRoleResources, { roleId: ID }), { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the resources');
  });
});

describe('BusinessRoleMembers', () => {
  const mount = (members = MEMBERS) => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(BusinessRoleMembers, { roleId: ID, onOpenDetail }), { auth: { authFetch: api({ members }) } });
    return { onOpenDetail, user: userEvent.setup() };
  };

  it('shows how each person got the role and through what', async () => {
    mount();
    const row = (await screen.findByText('Cy Both')).closest('tr');
    expect(within(row).getByText('Rule')).toBeInTheDocument();
    expect(within(row).getByText('Request')).toBeInTheDocument();
    expect(within(row).getByText('Everyone in IT, Request it')).toBeInTheDocument();
  });

  it('filters by the way the role was gained, counting a person under each way', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Rule (2)' }));
    expect(screen.getByText('Cy Both')).toBeInTheDocument();
    expect(screen.queryByText('Bo Request')).toBeNull();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Bo Request')).toBeInTheDocument();
  });

  it('searches by name and e-mail', async () => {
    const { user } = mount();
    const box = await screen.findByRole('searchbox', { name: /Search people/ });
    await user.type(box, 'bo@');
    expect(screen.getByText('Bo Request')).toBeInTheDocument();
    expect(screen.queryByText('Ann Rule')).toBeNull();
  });

  it('hides the filter when everyone got it the same way', async () => {
    mount([MEMBERS[0]]);
    await screen.findByText('Ann Rule');
    expect(screen.queryByRole('group', { name: /Filter by how/ })).toBeNull();
  });

  it('pages a long list without losing anyone', async () => {
    const many = Array.from({ length: MEMBER_PAGE_SIZE + 5 }, (_, i) => ({ principalId: `u${i}`, targetDisplayName: `Person ${i}`, howHeld: ['Rule'] }));
    const { user } = mount(many);
    expect(await screen.findByText('Person 0')).toBeInTheDocument();
    expect(screen.queryByText(`Person ${MEMBER_PAGE_SIZE}`)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(`Person ${MEMBER_PAGE_SIZE + 4}`)).toBeInTheDocument();
  });

  it('says when nobody holds the role', async () => {
    mount([]);
    expect(await screen.findByText('Nobody holds this role.')).toBeInTheDocument();
  });

  it('counts and filters a row without a stated way as Unknown', () => {
    const rows = [{ principalId: 'x' }, { principalId: 'y', howHeld: ['Rule'] }];
    expect(countByWay(rows)).toEqual({ Unknown: 1, Rule: 1 });
    expect(filterMembers(rows, '', 'Unknown').map(r => r.principalId)).toEqual(['x']);
  });
});

describe('WayChips', () => {
  it('shows what an empty list means', () => {
    renderWithProviders(h(WayChips, { ways: [], direction: 'out', none: 'Nothing removes it' }));
    expect(screen.getByText('Nothing removes it')).toBeInTheDocument();
  });

  it('shows Unknown for a missing list and for a value it does not know', () => {
    renderWithProviders(h('div', null, h(WayChips, { direction: 'in' }), h(WayChips, { ways: ['Later'], direction: 'in' })));
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });

  it('names a removal rule differently from a rule that hands the role out', () => {
    renderWithProviders(h('div', null, h(WayChips, { ways: ['Rule'], direction: 'in' }), h(WayChips, { ways: ['Rule'], direction: 'out' })));
    expect(screen.getByText('Rule')).toBeInTheDocument();
    expect(screen.getByText('Removal rule')).toBeInTheDocument();
  });
});

describe('BusinessRoleOwnerImport', () => {
  const PLAN = {
    summary: { roles: 2, toWrite: 2, unchanged: 0, kept: 1, problems: 1 },
    nearMatches: [{ kind: 'Principal', value: 'Anne Jansen', matched: 'Anna Jansen' }],
    rows: [
      { line: 2, businessRole: 'Finance', businessRoleName: 'Finance', changes: [
        { role: 'Accountable', value: 'ann', displayName: 'Ann A', action: 'set' },
        { role: 'Responsible', value: 'zed', displayName: null, action: 'unmatched' },
      ] },
      { line: 3, businessRole: 'Nope', problem: 'Business role not found', changes: [] },
    ],
  };

  function mount({ previewStatus = 200, plan = PLAN } = {}) {
    const calls = [];
    const authFetch = makeAuthFetch((url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/import/preview')) {
        return previewStatus === 200 ? plan : jsonResponse({ error: 'Add a "Business role" column' }, { ok: false, status: previewStatus });
      }
      if (u.endsWith('/import/apply')) return { written: 2, kept: 0, summary: plan.summary };
      return undefined;
    });
    const onClose = vi.fn();
    renderWithProviders(h(BusinessRoleOwnerImport, { onClose }), { auth: { authFetch } });
    return { calls, onClose, user: userEvent.setup() };
  }
  const file = new File(['Business role;Accountable\nFinance;ann\n'], 'owners.csv', { type: 'text/csv' });

  it('needs a file before it can preview', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('previews first and writes only on Apply', async () => {
    const { calls, user } = mount();
    await user.upload(screen.getByLabelText('Owner list'), file);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = await screen.findByTestId('owner-import-preview');
    expect(preview).toHaveTextContent('2 to write across 2 roles');
    expect(preview).toHaveTextContent('Accountable: Ann A, will be set');
    expect(preview).toHaveTextContent('Responsible: zed, no account found');
    expect(preview).toHaveTextContent('Business role not found');
    expect(preview).toHaveTextContent('Anne Jansen → Anna Jansen');
    expect(calls.some(c => c.endsWith('/apply'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('status')).toHaveTextContent('2 owners written');
    expect(calls.some(c => c.endsWith('/apply'))).toBe(true);
  });

  it('offers no Apply when there is nothing to write', async () => {
    const { user } = mount({ plan: { ...PLAN, summary: { ...PLAN.summary, toWrite: 0 } } });
    await user.upload(screen.getByLabelText('Owner list'), file);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled());
  });

  it('shows why a list was refused', async () => {
    const { user } = mount({ previewStatus: 400 });
    await user.upload(screen.getByLabelText('Owner list'), file);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/Add a "Business role" column/)).toBeInTheDocument();
  });

  it('choosing another file discards the earlier preview', async () => {
    const { user } = mount();
    await user.upload(screen.getByLabelText('Owner list'), file);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('owner-import-preview');
    await user.upload(screen.getByLabelText('Owner list'), new File(['x'], 'other.csv', { type: 'text/csv' }));
    expect(screen.queryByTestId('owner-import-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });
});
