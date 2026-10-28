// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import EntityDiff from './EntityDiff';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within, fireEvent,
} from '@ui/test-utils/renderWithProviders';

afterEach(() => vi.restoreAllMocks());

const USER = 'u-1';

const response = (overrides = {}) => ({
  at: '2026-09-27T00:00:00.000Z',
  historySince: '2026-06-01T00:00:00.000Z',
  relationshipsTracked: true,
  omittedUnchanged: 0,
  before: {
    exists: true, deleted: false,
    attributes: { department: 'Sales', jobTitle: 'Rep' },
    relationships: [
      { key: 'manager:m1', group: 'Manager', label: 'Alice Old', kind: 'user', id: 'm1', detail: '' },
      { key: 'held:g1', group: 'Groups', label: 'Finance Team', kind: 'resource', id: 'g1', detail: 'Direct' },
    ],
  },
  after: {
    exists: true, deleted: false,
    attributes: { department: 'Finance', jobTitle: 'Rep' },
    relationships: [
      { key: 'manager:m2', group: 'Manager', label: 'Bob New', kind: 'user', id: 'm2', detail: '' },
      { key: 'held:g1', group: 'Groups', label: 'Finance Team', kind: 'resource', id: 'g1', detail: 'Direct' },
      { key: 'held:br1', group: 'Business roles', label: 'Head of Sales', kind: 'access-package', id: 'br1', detail: 'Direct · governed' },
    ],
  },
  ...overrides,
});

function mount(body = response(), props = {}) {
  const authFetch = makeAuthFetch(() => jsonResponse(body));
  const onOpenDetail = vi.fn();
  renderWithProviders(h(EntityDiff, { entityKind: 'user', entityId: USER, authFetch, onOpenDetail, ...props }));
  return { authFetch, onOpenDetail };
}

const rowFor = text => screen.getByText(text).closest('li');

describe('EntityDiff', () => {
  it('fetches the 30-day comparison by default and shows both sides with highlights', async () => {
    const { authFetch } = mount();
    await screen.findByText('Sales');
    const url = authFetch.mock.calls[0][0];
    expect(url).toMatch(/^\/api\/user\/u-1\/diff\?at=/);
    const at = new Date(decodeURIComponent(url.split('at=')[1]));
    const daysAgo = (Date.now() - at.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(29.9);
    expect(daysAgo).toBeLessThan(30.1);

    expect(rowFor('Sales').dataset.status).toBe('changed');
    expect(rowFor('Alice Old').dataset.status).toBe('removed');
    expect(rowFor('Bob New').dataset.status).toBe('added');
    expect(rowFor('Head of Sales').dataset.status).toBe('added');
    expect(screen.getByText('Sales').closest('div').className).toContain('bg-red-50');
    expect(screen.getByText('Finance').closest('div').className).toContain('bg-green-50');
    expect(screen.getByText('2 added')).toBeTruthy();
    expect(screen.getByText('1 removed')).toBeTruthy();
    expect(screen.getByText('1 changed')).toBeTruthy();
  });

  it('re-fetches for a preset and for a picked date', async () => {
    const { authFetch } = mount();
    await screen.findByText('Sales');
    await userEvent.click(screen.getByRole('button', { name: '1 year ago' }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '1 year ago' }).getAttribute('aria-pressed')).toBe('true');

    // jsdom's date input doesn't take typed keystrokes; set the value directly.
    const input = screen.getByLabelText(/or date/);
    fireEvent.change(input, { target: { value: '2026-02-01' } });
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(3));
    const picked = new Date(decodeURIComponent(authFetch.mock.calls[2][0].split('at=')[1]));
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate(), picked.getHours()]).toEqual([2026, 1, 1, 0]);
    expect(screen.getByRole('button', { name: '1 year ago' }).getAttribute('aria-pressed')).toBe('false');

    // A date in the future is ignored — no new request.
    fireEvent.change(input, { target: { value: '2999-01-01' } });
    expect(authFetch).toHaveBeenCalledTimes(3);
  });

  it('"Only show differences" hides unchanged rows', async () => {
    mount();
    await screen.findByText('Sales');
    expect(screen.queryAllByText('Finance Team')).toHaveLength(2);
    await userEvent.click(screen.getByLabelText('Only show differences'));
    expect(screen.queryByText('Finance Team')).toBeNull();
    expect(screen.queryByText('Job Title')).toBeNull();
    expect(screen.getByText('Bob New')).toBeTruthy();
  });

  it('opens a related item in its detail tab', async () => {
    const { onOpenDetail } = mount();
    await screen.findByText('Sales');
    await userEvent.click(screen.getByRole('button', { name: 'Head of Sales' }));
    expect(onOpenDetail).toHaveBeenCalledWith('access-package', 'br1', 'Head of Sales');
  });

  it('explains the limits of the comparison', async () => {
    mount(response({
      at: '2026-01-01T00:00:00.000Z',
      omittedUnchanged: 1234,
      relationshipsTracked: false,
      before: { exists: false, deleted: false, attributes: {}, relationships: [] },
      after: { exists: true, deleted: true, attributes: { department: 'Finance' }, relationships: [] },
    }));
    await screen.findByText('Finance');
    const notes = screen.getByText(/Change history starts on/).closest('ul');
    expect(within(notes).getByText(/did not exist yet/)).toBeTruthy();
    expect(within(notes).getByText(/now deleted in the source/)).toBeTruthy();
    expect(within(notes).getByText(/1[.,\s]?234 unchanged relationships/)).toBeTruthy();
    expect(within(notes).getByText(/only its attributes are compared/)).toBeTruthy();
    expect(screen.getByText('No relationship changes.')).toBeTruthy();
  });

  it('shows an error when the request fails', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'x' }, { ok: false, status: 500 }));
    renderWithProviders(h(EntityDiff, { entityKind: 'resource', entityId: 'r-1', authFetch }));
    expect(await screen.findByText(/Could not load the comparison \(HTTP 500\)/)).toBeTruthy();
    expect(authFetch.mock.calls[0][0]).toMatch(/^\/api\/resources\/r-1\/diff/);
  });
});
