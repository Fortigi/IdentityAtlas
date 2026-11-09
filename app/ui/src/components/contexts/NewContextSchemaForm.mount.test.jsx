// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { renderWithProviders, makeAuthFetch, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';
import JsonSchemaForm from './NewContextSchemaForm';
import { seedParamsFromSchema } from './NewContextWizard.helpers';

// The parameter form for the manager-hierarchy rule's options: a dropdown for
// each enum, a checkbox per switch that starts at its default, the attribute
// picker for the split, and a person picker for the chosen top people.
const SCHEMA = {
  properties: {
    topMode: { type: 'string', enum: ['auto', 'jobTitle', 'people'], default: 'auto', 'x-enumLabels': { auto: 'Who has no manager', jobTitle: 'A job title', people: 'Chosen people' } },
    nameFrom: { type: 'string', enum: ['manager', 'members'] },
    topJobTitle: { type: 'string' },
    topPrincipalIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
    splitBy: { type: 'string', 'x-attributeSource': 'principal' },
    splitMinMembers: { type: 'integer', default: 2 },
    notPlacedUnit: { type: 'boolean', default: false },
    excludeInactive: { type: 'boolean' },
  },
};

function Harness({ onValues }) {
  const [values, setValues] = useState(() => seedParamsFromSchema({ parametersSchema: SCHEMA }));
  const change = (v) => { setValues(v); onValues(v); };
  return <JsonSchemaForm schema={SCHEMA} values={values} onChange={change} systems={[]} principalAttrs={{ columns: ['department', 'jobTitle'], extended: ['costCenter'] }} />;
}

function mount() {
  const onValues = vi.fn();
  const authFetch = makeAuthFetch({ '/api/users?search=': { data: [{ id: 'p-anna', displayName: 'Anna de Vries' }] } });
  renderWithProviders(<Harness onValues={onValues} />, { auth: { authFetch } });
  return { onValues, user: userEvent.setup(), last: () => onValues.mock.calls.at(-1)[0] };
}

// The control under one parameter's label (the form's labels are not linked to their inputs).
const fieldOf = (label) => screen.getByText(label, { selector: 'label' }).parentElement;

describe('JsonSchemaForm — manager-hierarchy options', () => {
  it('renders an enum as a dropdown with its labels and its default chosen', async () => {
    const { user, last } = mount();
    const select = within(fieldOf('Top Mode')).getByRole('combobox');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Who has no manager', 'A job title', 'Chosen people']);
    expect(select).toHaveDisplayValue('Who has no manager');
    await user.selectOptions(select, 'Chosen people');
    expect(last().topMode).toBe('people');
  });

  it('offers "(not set)" on an enum without a default, which leaves it out again', async () => {
    const { user, last } = mount();
    const select = within(fieldOf('Name From')).getByRole('combobox');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['(not set)', 'Manager', 'Members']);
    await user.selectOptions(select, 'Members');
    expect(last().nameFrom).toBe('members');
    await user.selectOptions(select, '(not set)');
    expect(last().nameFrom).toBeUndefined();
  });

  it('starts a switch at its default: off when the default is false, on without one', () => {
    mount();
    expect(within(fieldOf('Not Placed Unit')).getByRole('checkbox')).not.toBeChecked();
    expect(within(fieldOf('Exclude Inactive')).getByRole('checkbox')).toBeChecked();
    expect(within(fieldOf('Split Min Members')).getByRole('spinbutton')).toHaveValue(2);
  });

  it('picks the split attribute from the account attributes', async () => {
    const { user, last } = mount();
    const select = within(fieldOf('Split By')).getByRole('combobox');
    await user.selectOptions(select, 'department');
    expect(last().splitBy).toBe('department');
    await user.selectOptions(select, '(none)');
    expect(last().splitBy).toBeUndefined();
  });

  it('collects the top people by name, stores their ids, and removes one again', async () => {
    const { user, last } = mount();
    await user.type(screen.getByLabelText('Add a person'), 'ann');
    await user.click(await screen.findByRole('button', { name: /Anna de Vries/ }));
    expect(last().topPrincipalIds).toEqual(['p-anna']);
    expect(within(screen.getByRole('list', { name: 'Chosen people' })).getByText('Anna de Vries')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Anna de Vries' }));
    expect(last().topPrincipalIds).toEqual([]);
  });
});
