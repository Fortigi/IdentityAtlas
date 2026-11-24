// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import NewContextWizard from './NewContextWizard';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
import { runDisabled, runLabel } from './NewContextWizard.helpers';

vi.mock('@ui/hooks/useCanBuildContexts', () => ({ useCanBuildContexts: () => false }));

const plugin = {
  name: 'manager-hierarchy', displayName: 'Manager Hierarchy', targetType: 'Principal',
  parametersSchema: {
    'x-wizard': 'org',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer' },
      peopleFilters: { type: 'array', 'x-wizardDefault': [{ attribute: 'employeeId', condition: 'isNotNull' }] },
      excludeSecondAccounts: { type: 'boolean', default: false, 'x-wizardDefault': true },
      excludeInactive: { type: 'boolean', default: false, 'x-wizardDefault': true },
      managerPlacement: { type: 'string', enum: ['reportsUp', 'ownTeam'], default: 'reportsUp' },
      nameFrom: { type: 'string', enum: ['manager', 'members'], default: 'manager' },
    },
  },
};
const KEY = 'gen~11111111-1111-4111-8111-111111111111~inst-1';
const stored = { pluginName: 'manager-hierarchy', instanceKey: 'inst-1', params: { scopeSystemId: 1, managerPlacement: 'ownTeam' } };
const preview = (contextCount) => ({ contextCount, memberCount: 4, samples: { contexts: [], members: [] } });

const routes = (over = {}) => makeAuthFetch({
  'tree-settings': stored,
  'context-plugins/principal-attributes': { columns: ['employeeId'], extended: [] },
  'dry-run': preview(3),
  '/run': { runId: 'run-7' },
  'contexts?variant=generated': { data: [] },
  'context-plugins': { data: [plugin] },
  'systems': { data: [{ id: 1, displayName: 'EntraID' }] },
  ...over,
});

function open(authFetch) {
  const cb = { onClose: vi.fn(), onRunStarted: vi.fn() };
  renderWithProviders(h(NewContextWizard, { open: true, editTreeKey: KEY, ...cb }), { auth: { authFetch } });
  return { ...cb, user: userEvent.setup() };
}
async function toPreview(user) {
  await screen.findByText('Who belongs in this organisation?');
  await user.click(screen.getByText('Next ▸'));
  await screen.findByLabelText(/Yes, in the team they manage/);
  await user.click(screen.getByText('Next ▸'));
  await screen.findByText('What is a team called?');
  await user.click(screen.getByText('Next ▸'));
}

describe('wizard on an existing tree', () => {
  it('opens on the stored values, not on the defaults for a new tree', async () => {
    const { user } = open(routes());
    expect(await screen.findByText('Tree settings')).toBeInTheDocument();
    await screen.findByText('Who belongs in this organisation?');
    // The tree had no people filter: the HR default must not be slipped in.
    expect(screen.getByLabelText(/Every account/)).toBeChecked();
    expect(screen.getByLabelText(/second accounts/)).not.toBeChecked();
    expect(screen.queryByText('Back')).not.toBeInTheDocument();
    await user.click(screen.getByText('Next ▸'));
    expect(await screen.findByLabelText(/Yes, in the team they manage/)).toBeChecked();
  });

  it('applies changed settings onto the same tree', async () => {
    const authFetch = routes();
    const { user, onRunStarted, onClose } = open(authFetch);
    await screen.findByText('Who belongs in this organisation?');
    await user.click(screen.getByLabelText(/People managed by HR/));
    await toPreview(user);
    expect(screen.queryByText('Create a new tree')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Apply to tree')).toBeEnabled());
    await user.click(screen.getByText('Apply to tree'));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith('run-7'));
    expect(onClose).toHaveBeenCalled();
    const body = JSON.parse(authFetch.mock.calls.find(([u, o]) => u.endsWith('/run') && o?.method === 'POST')[1].body);
    expect(body).toMatchObject({ instanceKey: 'inst-1', scopeSystemId: 1, managerPlacement: 'ownTeam', peopleFilters: [{ attribute: 'employeeId', condition: 'isNotNull' }] });
  });

  it('refuses to apply settings that would leave an empty tree', async () => {
    const { user } = open(routes({ 'dry-run': preview(0) }));
    await toPreview(user);
    await screen.findByText(/0 contexts/);
    expect(screen.getByText('Apply to tree')).toBeDisabled();
  });

  it('says so when the settings cannot be loaded', async () => {
    open(routes({ 'tree-settings': jsonResponse({ error: 'The settings of this tree are not available' }, { ok: false, status: 404 }) }));
    expect(await screen.findByText('The settings of this tree are not available')).toBeInTheDocument();
    expect(screen.queryByText('Next ▸')).not.toBeInTheDocument();
  });

  it('says so when the rule is not one the wizard offers', async () => {
    open(routes({ 'tree-settings': { ...stored, pluginName: 'context-recipe' } }));
    expect(await screen.findByText('The settings of this tree cannot be changed here.')).toBeInTheDocument();
  });
});

describe('run button on an existing tree', () => {
  it('needs a preview with units only when editing', () => {
    expect(runDisabled(false, false, 'refresh', 'k', true, 0)).toBe(true);
    expect(runDisabled(false, false, 'refresh', 'k', true, 2)).toBe(false);
    expect(runDisabled(false, false, 'new', '', false, 0)).toBe(false);
    expect(runLabel(false, 'refresh', true)).toBe('Apply to tree');
    expect(runLabel(true, 'refresh', true)).toBe('Starting…');
  });
});
