// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import NewContextWizard from './NewContextWizard';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';
import { peoplePreset, presetFilters, incompletePeopleRule, pickSchema, orgMoreOptionsSchema, orgStepFor, stepsFor, seedParamsFromSchema } from './NewContextWizard.helpers';

vi.mock('@ui/hooks/useCanBuildContexts', () => ({ useCanBuildContexts: () => false }));

const plugin = {
  name: 'manager-hierarchy', displayName: 'Manager Hierarchy', description: 'From manager links.', targetType: 'Principal',
  parametersSchema: {
    'x-wizard': 'org',
    required: ['scopeSystemId'],
    properties: {
      scopeSystemId: { type: 'integer', description: 'Which system' },
      rootName: { type: 'string', default: 'Organization', description: 'Root' },
      nameFields: { type: 'array', items: { type: 'string' }, default: ['department'], 'x-attributeSource': 'principal', description: 'Name' },
      includeManagerName: { type: 'boolean', default: true, description: 'Append' },
      nameFrom: { type: 'string', enum: ['manager', 'members'], default: 'manager' },
      excludeInactive: { type: 'boolean', default: false, 'x-wizardDefault': true },
      peopleFilters: { type: 'array', 'x-wizardDefault': [{ attribute: 'employeeId', condition: 'isNotNull' }] },
      excludeSecondAccounts: { type: 'boolean', default: false, 'x-wizardDefault': true },
      managerPlacement: { type: 'string', enum: ['reportsUp', 'ownTeam'], default: 'reportsUp' },
    },
  },
};

const stats = { accountsTotal: 10, peopleIncluded: 7, filteredOut: 2, secondAccounts: 1 };
const routes = () => makeAuthFetch({
  'context-plugins/principal-attributes': { columns: ['department', 'employeeId'], extended: [] },
  'dry-run': { contextCount: 3, memberCount: 7, stats, samples: { contexts: [], members: [] } },
  '/run': { runId: 'run-1' },
  'contexts?variant=generated': { data: [] },
  'context-plugins': { data: [plugin] },
  'systems': { data: [{ id: 1, displayName: 'EntraID' }] },
});

async function openPeopleStep(authFetch) {
  const onRunStarted = vi.fn();
  renderWithProviders(h(NewContextWizard, { open: true, onClose: vi.fn(), onRunStarted }), { auth: { authFetch } });
  const user = userEvent.setup();
  await user.click(await screen.findByText('Derive from data'));
  await user.click(screen.getByText('Next ▸'));
  await user.click(await screen.findByText('Manager Hierarchy'));
  await user.click(screen.getByText('Next ▸'));
  await screen.findByText('Who belongs in this organisation?');
  return { user, onRunStarted };
}
const bodyOf = (authFetch, part) => JSON.parse(authFetch.mock.calls.find(([u]) => u.includes(part))[1].body);

describe('guided organisation steps', () => {
  it('walks people, managers and names, and sends the choices', async () => {
    const authFetch = routes();
    const { user, onRunStarted } = await openPeopleStep(authFetch);

    expect(screen.getByLabelText(/People managed by HR/)).toBeChecked();
    expect(screen.getByText('Next ▸')).toBeDisabled(); // no system yet
    await user.selectOptions(screen.getAllByRole('combobox')[0], '1');
    await user.click(screen.getByText('Next ▸'));

    await user.click(await screen.findByLabelText(/Yes, in the team they manage/));
    await user.click(screen.getByText('Next ▸'));

    await user.click(await screen.findByLabelText(/After what the team members share/));
    await user.click(screen.getByText('Next ▸'));

    expect(await screen.findByText(/7 of 10 accounts are in/)).toBeInTheDocument();
    await user.click(screen.getByText('Create tree'));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith('run-1'));
    expect(bodyOf(authFetch, '/run')).toMatchObject({
      scopeSystemId: 1, managerPlacement: 'ownTeam', nameFrom: 'members',
      excludeSecondAccounts: true, excludeInactive: true,
      peopleFilters: [{ attribute: 'employeeId', condition: 'isNotNull' }],
    });
  });

  it('counts people on the first step, and a changed choice clears the count', async () => {
    const authFetch = routes();
    const { user } = await openPeopleStep(authFetch);
    await user.selectOptions(screen.getAllByRole('combobox')[0], '1');
    await user.click(screen.getByText('Count people'));
    expect(await screen.findByText(/7 of 10 accounts are in. Left out: 2 by the rule, 1 second accounts/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Every account/));
    expect(screen.queryByText(/7 of 10/)).not.toBeInTheDocument();
  });

  it('blocks Next on an unfinished custom rule until it is filled in', async () => {
    const authFetch = routes();
    const { user } = await openPeopleStep(authFetch);
    await user.selectOptions(screen.getAllByRole('combobox')[0], '1');
    await user.click(screen.getByLabelText(/A rule of my own/));
    expect(screen.getByText('Next ▸')).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Attribute' }), 'department');
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'Sales');
    expect(screen.getByText('Next ▸')).toBeEnabled();
  });
});

describe('guided step helpers', () => {
  it('recognises the three people choices', () => {
    expect(peoplePreset(undefined)).toBe('all');
    expect(peoplePreset([])).toBe('all');
    expect(peoplePreset(presetFilters('hr'))).toBe('hr');
    expect(peoplePreset(presetFilters('custom'))).toBe('custom');
    expect(peoplePreset([{ attribute: 'employeeId', condition: 'equals', value: 'x' }])).toBe('custom');
    expect(peoplePreset([...presetFilters('hr'), ...presetFilters('hr')])).toBe('custom');
    expect(presetFilters('all')).toEqual([]);
  });

  it.each([
    [undefined, false],
    [[{ attribute: 'a', condition: 'isNotNull' }], false],
    [[{ attribute: '', condition: 'isNotNull' }], true],
    [[{ attribute: 'a', condition: 'equals', value: ' ' }], true],
    [[{ attribute: 'a', condition: 'equals', value: 'x' }], false],
    [[{ attribute: 'a', condition: 'inValues', values: [' '] }], true],
    [[{ attribute: 'a', condition: 'inValues' }], true],
    [[{ attribute: 'a', condition: 'inValues', values: ['x', ''] }], false],
  ])('incompletePeopleRule(%j) is %s', (filters, expected) => {
    expect(incompletePeopleRule(filters)).toBe(expected);
  });

  it('picks schema fields in the asked order and keeps only their required flags', () => {
    const schema = { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } };
    const picked = pickSchema(schema, ['c', 'a', 'missing']);
    expect(Object.keys(picked.properties)).toEqual(['c', 'a']);
    expect(picked.required).toEqual(['a']);
    expect(pickSchema(undefined, ['a'])).toMatchObject({ properties: {}, required: [] });
  });

  it('leaves only what the guided steps do not ask in More options', () => {
    expect(Object.keys(orgMoreOptionsSchema(plugin.parametersSchema).properties)).toEqual(['rootName']);
  });

  it('maps guided steps only for a guided plugin', () => {
    expect([3, 4, 5, 6].map(n => orgStepFor(n, plugin))).toEqual(['people', 'managers', 'names', null]);
    expect(orgStepFor(3, { parametersSchema: {} })).toBeNull();
    expect(stepsFor('plugin', plugin).map(s => s.label)).toEqual(['Source', 'Pick a rule', 'People', 'Managers', 'Names', 'Preview & run']);
    expect(stepsFor('plugin', { parametersSchema: {} })).toHaveLength(4);
  });

  it('seeds the wizard default over the API default', () => {
    const seeded = seedParamsFromSchema(plugin);
    expect(seeded.excludeSecondAccounts).toBe(true);
    expect(seeded.managerPlacement).toBe('reportsUp');
    expect(seeded.peopleFilters).toEqual([{ attribute: 'employeeId', condition: 'isNotNull' }]);
  });
});

describe('guided steps — the rule editor and more options', () => {
  it('builds an "is one of" and a pattern rule, and sends them', async () => {
    const authFetch = routes();
    const { user } = await openPeopleStep(authFetch);
    await user.selectOptions(screen.getAllByRole('combobox')[0], '1');
    await user.click(screen.getByLabelText(/A rule of my own/));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Attribute' }), 'department');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Condition' }), 'inValues');
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'IT, HR');
    await user.click(screen.getByText('Count people'));
    await screen.findByText(/7 of 10 accounts are in/);
    expect(bodyOf(authFetch, 'dry-run').peopleFilters).toEqual([{ attribute: 'department', condition: 'inValues', values: ['IT', 'HR'] }]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Condition' }), 'notMatches');
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('');
    await user.type(screen.getByRole('textbox', { name: 'Value' }), '^adm');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Condition' }), 'isNotNull');
    expect(screen.queryByRole('textbox', { name: 'Value' })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Leave out disabled accounts/));
    await user.click(screen.getByText('Next ▸'));
    await user.click(await screen.findByLabelText(/No, in the team above/));
    await user.click(screen.getByText('Next ▸'));
    await user.click(await screen.findByLabelText(/After the manager's attribute/));
    await user.click(screen.getByText('More options'));
    expect(screen.getByText('Root Name')).toBeInTheDocument();
  });
});
