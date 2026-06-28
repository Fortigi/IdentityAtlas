// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import DepartmentDetailPage from './DepartmentDetailPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, userEvent } from '@ui/test-utils/renderWithProviders';

// Org-chart user fixtures. The component's buildDeptTree picks the manager-less
// user that has reports and the highest report count as the tree root, then
// groups descendants by department. We build:
//   ceo (Executive, root)
//     -> eng-lead (Engineering)          <- target department, direct members
//          -> eng-ic1 (Engineering)      <- direct (same dept merges in)
//          -> qa-ic1 (Quality)           <- indirect (sub-department child)
//          -> qa-ic2 (Quality)           <- indirect
const users = [
  { id: 'ceo', displayName: 'Carol CEO', department: 'Executive', jobTitle: 'CEO', managerId: null, riskScore: 90, riskTier: 'Critical', riskHierarchyTotalReports: 4 },
  { id: 'eng-lead', displayName: 'Erin Lead', department: 'Engineering', jobTitle: 'Eng Manager', managerId: 'ceo', riskScore: 70, riskTier: 'High' },
  { id: 'eng-ic1', displayName: 'Evan IC', department: 'Engineering', jobTitle: 'Engineer', managerId: 'eng-lead', riskScore: 30, riskTier: 'Low' },
  { id: 'qa-ic1', displayName: 'Quinn QA', department: 'Quality', jobTitle: 'QA Engineer', managerId: 'eng-lead', riskScore: 55, riskTier: 'Medium' },
  { id: 'qa-ic2', displayName: 'Quincy QA', department: 'Quality', jobTitle: 'QA Lead', managerId: 'eng-lead', riskScore: 20, riskTier: 'Minimal' },
];

function orgFetch(extra = {}) {
  return makeAuthFetch({ '/api/org-chart': { available: true, users }, ...extra });
}

function render(props = {}, authFetch = orgFetch()) {
  return renderWithProviders(
    h(DepartmentDetailPage, {
      departmentName: 'Engineering',
      onClose: () => {},
      onOpenDetail: () => {},
      ...props,
    }),
    { auth: { authFetch } },
  );
}

describe('DepartmentDetailPage (mounted)', () => {
  it('shows a loading state before data resolves', () => {
    render();
    expect(screen.getByText('Loading department details...')).toBeInTheDocument();
  });

  it('renders the department header, sub-departments and risk summary after load', async () => {
    render();

    // Header — department name appears once data is built.
    expect(await screen.findByRole('heading', { name: 'Engineering' })).toBeInTheDocument();

    // Risk summary block.
    expect(screen.getByText('Risk Summary')).toBeInTheDocument();
    expect(screen.getByText('Risk distribution')).toBeInTheDocument();
    expect(screen.getByText('Highest risk members')).toBeInTheDocument();

    // Quality is a sub-department of Engineering.
    expect(screen.getByText(/Sub-departments/)).toBeInTheDocument();
    expect(screen.getAllByText(/Quality/).length).toBeGreaterThan(0);

    // Direct member is listed (appears in both the member table and the
    // highest-risk panel, so there may be more than one button).
    expect(screen.getAllByRole('button', { name: 'Evan IC' }).length).toBeGreaterThan(0);
  });

  it('switches to the Indirect Members tab and shows descendant members', async () => {
    render();
    const user = userEvent.setup();

    // Indirect tab only appears when there are indirect members (the QA folks).
    const indirectTab = await screen.findByRole('button', { name: /Indirect Members \(2\)/ });
    await user.click(indirectTab);

    // Indirect members carry a department annotation in non-direct tabs.
    expect((await screen.findAllByRole('button', { name: 'Quinn QA' })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Quincy QA' }).length).toBeGreaterThan(0);
  });

  it('switches to the All Members tab showing every descendant', async () => {
    render();
    const user = userEvent.setup();

    const allTab = await screen.findByRole('button', { name: /All Members \(4\)/ });
    await user.click(allTab);

    expect((await screen.findAllByRole('button', { name: 'Evan IC' })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Quinn QA' }).length).toBeGreaterThan(0);
  });

  it('invokes onOpenDetail when a member name is clicked', async () => {
    let opened = null;
    render({ onOpenDetail: (kind, id, name) => { opened = { kind, id, name }; } });
    const user = userEvent.setup();

    const memberBtns = await screen.findAllByRole('button', { name: 'Evan IC' });
    await user.click(memberBtns[0]);

    expect(opened).toEqual({ kind: 'user', id: 'eng-ic1', name: 'Evan IC' });
  });

  it('invokes onClose when the header close button is clicked', async () => {
    let closed = false;
    render({ onClose: () => { closed = true; } });
    const user = userEvent.setup();

    const closeBtn = await screen.findByTitle('Close');
    await user.click(closeBtn);

    expect(closed).toBe(true);
  });

  it('shows an error panel when the org-chart fetch fails', async () => {
    render({}, orgFetch({ '/api/org-chart': jsonResponse({}, { ok: false, status: 503 }) }));

    expect(await screen.findByText('Failed to load department')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  });

  it('shows an error when org-chart data is not available', async () => {
    render({}, orgFetch({ '/api/org-chart': { available: false } }));
    expect(await screen.findByText('Org chart data not available.')).toBeInTheDocument();
  });

  it('shows a not-found error when the department is absent from the org chart', async () => {
    render({ departmentName: 'Marketing' });
    expect(await screen.findByText(/Department "Marketing" not found/)).toBeInTheDocument();
  });

  it('uses cachedData without fetching when provided', async () => {
    const node = {
      department: 'Cached Dept',
      members: [{ id: 'm1', displayName: 'Mona M', jobTitle: 'Analyst', riskScore: 12, riskTier: 'Minimal' }],
      children: [],
      directCount: 1,
      indirectCount: 0,
    };
    const authFetch = orgFetch();
    render({ departmentName: 'Cached Dept', cachedData: { node } }, authFetch);

    expect(await screen.findByRole('heading', { name: 'Cached Dept' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mona M' }).length).toBeGreaterThan(0);
    // cachedData short-circuits the effect, so no fetch should fire.
    expect(authFetch).not.toHaveBeenCalled();
  });
});
