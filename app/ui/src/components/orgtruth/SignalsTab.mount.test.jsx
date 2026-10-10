// @vitest-environment jsdom
//
// Organisation → Signals against stubbed routes: the collection type picker
// (enrichment / relation types left out, the activity subject first), the four
// finding lists with their counts and links, the settings PUT body, and the
// read-only settings for a reader.
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, makeAuthFetch, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import SignalsTab from './SignalsTab';

const IMPORTER = { hasWildcard: false, permissions: new Set(['data.read', 'data.write.contexts']) };
const READER = { hasWildcard: false, permissions: new Set(['data.read']) };

const MODEL = {
  entityTypes: [
    { type: 'Project', template: 'collection', attributeKeys: ['status'] },
    { type: 'Klant', attributeKeys: ['archief', 'sector'] },
    { type: 'Maten', template: 'enrichment', attributeKeys: ['expertises'] },
  ],
  activities: [{ type: 'Uren', subjectType: 'OrgEntity', subjectEntityType: 'Klant' }],
};
const SETTINGS = {
  Project: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: [] },
  Klant: { inactiveAfterMonths: 9, statusAttribute: 'archief', inactiveValues: ['true'] },
};
const KLANT_SIGNALS = {
  type: 'Klant', asOf: '2026-06-30', settings: SETTINGS.Klant,
  findings: {
    inactive: [
      { entityId: 'k1', label: 'Contoso', lastActivityOn: '2025-08-01', monthsSince: 10 },
      { entityId: 'k2', label: 'Northwind', lastActivityOn: null },
    ],
    markedInactiveButActive: [{ entityId: 'k3', label: 'Fabrikam', statusValue: 'true', lastActivityOn: '2026-06-01' }],
    activeWithoutMembership: [{ entityId: 'k3', label: 'Fabrikam', actor: { targetType: 'Identity', targetId: 'i1', label: 'Ann Example' }, total: 32, lastOn: '2026-06-01' }],
    memberWithoutActivity: [],
  },
};

function render({ auth = IMPORTER, put = { ok: true } } = {}) {
  const authFetch = makeAuthFetch((url, opts) => {
    if (url.startsWith('/api/org-truth/model')) return MODEL;
    if (url === '/api/org-truth/signals/settings') return opts.method === 'PUT' ? (typeof put === 'function' ? put() : put) : SETTINGS;
    if (url === '/api/org-truth/signals?type=Klant') return KLANT_SIGNALS;
    if (url === '/api/org-truth/signals?type=Project') return { type: 'Project', asOf: null, findings: {} };
    return undefined;
  });
  const onOpenDetail = vi.fn();
  renderWithProviders(<SignalsTab onOpenDetail={onOpenDetail} />, { auth: { authFetch, ...auth }, features: { orgTruth: true } });
  return { authFetch, onOpenDetail };
}

const list = async (name) => within(await screen.findByRole('region', { name }));

describe('SignalsTab', () => {
  it('offers only collection types, the one activity is about first and selected', async () => {
    render();
    const select = await screen.findByRole('combobox', { name: 'Collection type' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Klant', 'Project']);
    expect(select).toHaveValue('Klant');
    expect(await screen.findByText('Measured against the latest activity in the data: June 2026.')).toBeInTheDocument();
  });

  it('shows the four lists with their counts and rows', async () => {
    render();
    const inactive = await list('Inactive');
    expect(inactive.getByText('(2)')).toBeInTheDocument();
    expect(inactive.getByText('last activity August 2025 · 10 months ago')).toBeInTheDocument();
    expect(inactive.getByText('no activity recorded')).toBeInTheDocument();
    expect((await list('Marked inactive but still active')).getByText('marked “true” · last activity June 2026')).toBeInTheDocument();
    expect((await list('Active without being a member')).getByText('(1)')).toBeInTheDocument();
    const members = await list('Member without activity');
    expect(members.getByText('(0)')).toBeInTheDocument();
    expect(members.getByText('None.')).toBeInTheDocument();
  });

  it('links an entity to its detail tab and a person to theirs', async () => {
    const { onOpenDetail } = render();
    const active = await list('Active without being a member');
    await userEvent.click(active.getByRole('button', { name: 'Fabrikam' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('org-entity', 'k3', 'Fabrikam');
    await userEvent.click(active.getByRole('button', { name: 'Ann Example' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('identity', 'i1', 'Ann Example');
  });

  it('reads the other type\'s findings when it is picked', async () => {
    const { authFetch } = render();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Collection type' }), 'Project');
    expect(await screen.findByText('No activity has been imported for this type yet.')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/org-truth/signals?type=Project');
    expect(screen.getByRole('spinbutton', { name: 'Inactive after (months)' })).toHaveValue(3);
  });

  it('saves the settings of the shown type with every other type kept, then reloads the findings', async () => {
    const { authFetch } = render();
    const months = await screen.findByRole('spinbutton', { name: 'Inactive after (months)' });
    expect(months).toHaveValue(9);
    await userEvent.clear(months);
    await userEvent.type(months, '12');
    const values = screen.getByRole('textbox', { name: 'Values that mean inactive' });
    await userEvent.clear(values);
    await userEvent.type(values, 'true, ja');
    const before = authFetch.mock.calls.filter(c => c[0] === '/api/org-truth/signals?type=Klant').length;
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    const put = await waitFor(() => {
      const call = authFetch.mock.calls.find(c => c[1]?.method === 'PUT');
      expect(call).toBeTruthy();
      return call;
    });
    expect(put[0]).toBe('/api/org-truth/signals/settings');
    expect(JSON.parse(put[1].body)).toEqual({
      Project: { inactiveAfterMonths: 3, statusAttribute: null, inactiveValues: [] },
      Klant: { inactiveAfterMonths: 12, statusAttribute: 'archief', inactiveValues: ['true', 'ja'] },
    });
    expect(await screen.findByText('Signal settings for Klant saved')).toBeInTheDocument();
    await waitFor(() => expect(authFetch.mock.calls.filter(c => c[0] === '/api/org-truth/signals?type=Klant').length).toBe(before + 1));
  });

  it('refuses a period outside 1–120 months without calling the API', async () => {
    const { authFetch } = render();
    const months = await screen.findByRole('spinbutton', { name: 'Inactive after (months)' });
    await userEvent.clear(months);
    await userEvent.type(months, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('from 1 to 120');
    expect(authFetch.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(false);
  });

  it('shows the server\'s refusal inline', async () => {
    render({ put: () => ({ ok: false, status: 400, json: async () => ({ error: 'unknown attribute' }) }) });
    await screen.findByRole('spinbutton', { name: 'Inactive after (months)' });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The settings were not saved: unknown attribute');
  });

  it('shows a reader the settings read-only, without Save', async () => {
    render({ auth: READER });
    expect(await screen.findByRole('spinbutton', { name: 'Inactive after (months)' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Status attribute' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(screen.getByText(/needs permission to import/)).toBeInTheDocument();
  });

  it('says there is nothing to signal without a collection type', async () => {
    const authFetch = makeAuthFetch({ '/api/org-truth/model': { entityTypes: [{ type: 'Maten', template: 'enrichment' }] } });
    renderWithProviders(<SignalsTab onOpenDetail={() => {}} />, { auth: { authFetch, ...IMPORTER }, features: { orgTruth: true } });
    expect(await screen.findByText('No collections yet')).toBeInTheDocument();
  });
});
