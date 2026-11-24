// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AccessPackageDetailPage from '@ui/components/AccessPackageDetailPage';
import BusinessRoleMembers from './BusinessRoleMembers';
import { countByWay, filterMembers, MEMBER_PAGE_SIZE } from './accessModel';
import BusinessRoleResources from './BusinessRoleResources';
import BusinessRoleOverview from './BusinessRoleOverview';
import BusinessRoleOwnerImport from './BusinessRoleOwnerImport';
import WayChips from './WayChips';
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
  accessModel: { waysIn: ['Rule', 'Request'], waysOut: ['Rule', 'Review', 'Expiry'] },
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

function api({ body = role(), policies = [RULE_POLICY, REQUEST_POLICY], members = MEMBERS, resources = RESOURCES } = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/api/risk-scores/')) return jsonResponse(null, { ok: false, status: 404 });
    if (u === `${BASE}/owners`) return [];
    if (u === `${BASE}/owners/suggestions`) return {};
    if (u === `${BASE}/policies`) return policies;
    if (u === `${BASE}/assignments`) return members;
    if (u === `${BASE}/resource-roles`) return resources;
    if (u === `${BASE}/reviews` || u === `${BASE}/requests`) return [];
    if (u === BASE) return body;
    return undefined;
  });
}

function mountPage(opts, wrap = (el) => el) {
  const onOpenDetail = vi.fn();
  renderWithProviders(wrap(h(AccessPackageDetailPage, { accessPackageId: ID, onClose: () => {}, onOpenDetail })), { auth: { authFetch: api(opts) } });
  return { onOpenDetail, user: userEvent.setup() };
}

describe('the business role page', () => {
  it('opens on the Overview and states the ways in and out in the header', async () => {
    mountPage();
    const header = await screen.findByTestId('role-access-model');
    expect(within(header).getByText('Rule')).toBeInTheDocument();
    expect(within(header).getByText('Request')).toBeInTheDocument();
    expect(within(header).getByText('Removal rule')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the rule and how many people hold the role through it', async () => {
    mountPage();
    expect(await screen.findByText('(user.department -eq "IT")')).toBeInTheDocument();
    expect(screen.getByText('Added and removed by this rule')).toBeInTheDocument();
    expect(screen.getByText(/12 people hold the role through this policy/)).toBeInTheDocument();
    expect(screen.getByText(/1 person holds the role through this policy/)).toBeInTheDocument();
  });

  it('shows the approval, expiry and review of a requestable policy', async () => {
    mountPage();
    expect(await screen.findByText('Requests need approval')).toBeInTheDocument();
    expect(screen.getByText('Ends after 90 days')).toBeInTheDocument();
    expect(screen.getByText('Access review: recurs every 3 months')).toBeInTheDocument();
  });

  it('explains a removal rule that has no rule text', async () => {
    mountPage({ policies: [{ ...REQUEST_POLICY, targetRule: null, hasAccessReview: false }] });
    expect(await screen.findByText(/leaves the people this policy allows/)).toBeInTheDocument();
  });

  it('says so when the source delivers no policies', async () => {
    mountPage({ policies: [], body: role({ accessModel: { waysIn: ['Unknown'], waysOut: ['Unknown'] } }) });
    expect(await screen.findByText(/delivers no assignment policies/)).toBeInTheDocument();
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
  });
});

describe('BusinessRoleOverview', () => {
  it('shows the review status with days overdue', async () => {
    const data = role({ complianceStatus: 'Missed', daysOverdue: 5, lastReviewDate: '2026-03-01T00:00:00Z', lastReviewedBy: 'auditor' });
    renderWithProviders(h(BusinessRoleOverview, { roleId: ID, data, onOpenTab: () => {} }), { auth: { authFetch: api() } });
    expect(await screen.findByText('Missed (5d ago)')).toBeInTheDocument();
    expect(screen.getByText(/by auditor/)).toBeInTheDocument();
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
