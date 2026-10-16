// @vitest-environment jsdom
//
// "Evidence from other lists" against a stubbed GET /entities/:id/evidence: a
// customer whose owner wrote hours, a team member who did not, one person who
// worked on it without being listed; hidden when there is nothing to say; 501.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, within } from '@ui/test-utils/renderWithProviders';
import OrgEvidenceSection from './OrgEvidenceSection';

const URL = '/api/org-truth/entities/c%201/evidence';

const EVIDENCE = {
  entity: { id: 'c 1', entityType: 'Customer', displayName: 'Northwind Traders' },
  people: [
    { via: 'eigenaar', principals: [{ principalId: 'p1', label: 'Alice Contoso', worked: true, rows: 40, hours: 312.5, lastPeriod: '2026-09' }] },
    { via: 'team', principals: [
      { principalId: 'p1', label: 'Alice Contoso', worked: true, rows: 40, hours: 312.5, lastPeriod: '2026-09' },
      { principalId: 'p2', label: 'Bob Contoso', worked: false, rows: 0, hours: 0, lastPeriod: null },
    ] },
  ],
  activity: { referrerTypes: ['TimesheetRow'], rows: 52, hours: 401, firstPeriod: '2025-01', lastPeriod: '2026-09', periods: 21, unlinkedRows: 2 },
  workedNotListed: [{ principalId: 'p3', label: 'Carol Northwind', rows: 12, hours: 88.5, lastPeriod: '2026-03' }],
};

function render(response = EVIDENCE) {
  const authFetch = makeAuthFetch({ '/evidence': response });
  const onOpenDetail = vi.fn();
  const view = renderWithProviders(<OrgEvidenceSection entityId="c 1" onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
  return { authFetch, onOpenDetail, ...view };
}

const tableOf = (title) => screen.getByRole('heading', { level: 4, name: title }).parentElement.querySelector('table');
const rowTexts = (table) => [...table.querySelectorAll('tbody tr')].map(r => [...r.cells].map(c => c.textContent));

afterEach(() => vi.useRealTimers());

describe('OrgEvidenceSection', () => {
  it('shows the verdict, the activity line and who of the listed people worked', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 15) });
    const { authFetch } = render();
    expect(await screen.findByText('Hours written until September 2026')).toHaveAttribute('data-verdict', 'active');
    expect(authFetch).toHaveBeenCalledWith(URL);
    expect(screen.getByText('Evidence from other lists')).toBeInTheDocument();
    expect(screen.getByText('52 rows · 401 hours · from January 2025 to September 2026 · 2 rows whose person is not linked to an account')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 listed people wrote hours on it')).toBeInTheDocument();
  });

  it('shows one table per via attribute, in words', async () => {
    render();
    await screen.findByRole('heading', { level: 4, name: 'eigenaar' });
    expect(rowTexts(tableOf('eigenaar'))).toEqual([['Alice Contoso', 'yes, until September 2026', '312.5']]);
    expect(rowTexts(tableOf('team'))).toEqual([
      ['Alice Contoso', 'yes, until September 2026', '312.5'],
      ['Bob Contoso', 'no hours found', '0'],
    ]);
    expect([...tableOf('team').querySelectorAll('th')].map(th => th.textContent)).toEqual(['Person', 'Worked on it', 'Hours']);
  });

  it('lists who worked on it without being listed', async () => {
    render();
    await screen.findByRole('heading', { level: 4, name: 'Worked on it but not listed' });
    expect(rowTexts(tableOf('Worked on it but not listed'))).toEqual([['Carol Northwind', '88.5', 'March 2026']]);
  });

  it('opens a person as an account', async () => {
    const { onOpenDetail } = render();
    await screen.findByRole('heading', { level: 4, name: 'team' });
    await userEvent.click(within(tableOf('team')).getByRole('button', { name: 'Bob Contoso' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p2', 'Bob Contoso');
    await userEvent.click(screen.getByRole('button', { name: 'Carol Northwind' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p3', 'Carol Northwind');
  });

  it('says no other list refers to it when only people are linked, and leaves out empty tables', async () => {
    render({ ...EVIDENCE, activity: null, workedNotListed: [] });
    expect(await screen.findByText('No other list refers to this entity')).toHaveAttribute('data-verdict', 'none');
    expect(screen.queryByText(/rows ·/)).toBeNull();
    expect(screen.queryByRole('heading', { level: 4, name: 'Worked on it but not listed' })).toBeNull();
  });

  it('shows the activity alone when nobody is linked', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 15) });
    render({ ...EVIDENCE, people: [], workedNotListed: undefined, activity: { ...EVIDENCE.activity, lastPeriod: '2024-02', unlinkedRows: 0 } });
    expect(await screen.findByText('No hours since February 2024')).toHaveAttribute('data-verdict', 'inactive');
    expect(screen.getByText('52 rows · 401 hours · from January 2025 to February 2024')).toBeInTheDocument();
    expect(screen.queryByText(/listed people/)).toBeNull();
  });

  it('hides itself when nobody is linked and no other list refers to it', async () => {
    const { authFetch, container } = render({ ...EVIDENCE, people: [], activity: null, workedNotListed: [] });
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalled());
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('Evidence from other lists')).toBeNull();
  });

  it('renders a 501 as not available yet', async () => {
    render(jsonResponse({}, { ok: false, status: 501 }));
    expect(await screen.findByText('Evidence — not available yet')).toBeInTheDocument();
  });
});
