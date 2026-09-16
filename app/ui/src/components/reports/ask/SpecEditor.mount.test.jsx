// @vitest-environment jsdom
//
// The editable report definition — what this pins down:
//   • every condition type the editor supports renders its own controls, and
//     each edit is reported upward as a whole new spec with the right shape
//   • a field swap keeps the operator only when the new type still allows it,
//     and seeds a value that matches the new type (true / first enum / '')
//   • a value is reported in the type the compiler expects: a number as a
//     number, a boolean as a boolean, an emptied number box as '' (not 0)
//   • the operator's needsValue decides whether a value control exists at all
//   • conditions can be added (plain, related, group, compare) and removed by
//     index; a nested list edits the RELATED entity, not the report entity
//   • all/any appears only when there is more than one condition to combine,
//     for the report, a relation and a group alike
//   • columns toggle on and off, and compare.* columns only exist once the
//     definition actually compares something (at the root or inside a group)
//   • a comparison row is delegated to CompareCondition, wired to the shared
//     remove button — CompareCondition's own behaviour is tested separately
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, within, userEvent } from '@ui/test-utils/renderWithProviders';
import SpecEditor from './SpecEditor';

// Shaped exactly like GET /api/nl-reports/catalog: fields/relations/columns are
// arrays of records, operators a map, operatorsByType a map of type → op names.
const CATALOG = {
  operators: {
    eq: { label: 'is', needsValue: true },
    neq: { label: 'is not', needsValue: true },
    contains: { label: 'contains', needsValue: true },
    isEmpty: { label: 'is empty', needsValue: false },
    isNotEmpty: { label: 'is not empty', needsValue: false },
    gt: { label: 'is more than', needsValue: true },
    lt: { label: 'is less than', needsValue: true },
    withinLastDays: { label: 'is within the last N days', needsValue: true },
    olderThanDays: { label: 'is more than N days ago', needsValue: true },
  },
  operatorsByType: {
    text: ['eq', 'neq', 'contains', 'isEmpty', 'isNotEmpty'],
    enum: ['eq', 'neq', 'isEmpty', 'isNotEmpty'],
    boolean: ['eq', 'isEmpty', 'isNotEmpty'],
    number: ['eq', 'neq', 'gt', 'lt', 'isEmpty', 'isNotEmpty'],
    // A date has no 'eq'/'contains', so switching a field to it must fall back
    // to this list's first entry — which is not the operator any other type
    // starts with.
    date: ['withinLastDays', 'olderThanDays', 'isEmpty', 'isNotEmpty'],
  },
  compareMeasures: { identical: 'exactly the same', containsAll: 'contains all of', similar: 'mostly the same (≥ %)' },
  entities: {
    user: {
      label: 'User',
      table: 'Principals',
      defaultColumns: ['displayName', 'email'],
      compareRelations: ['memberOf'],
      // 'id' deliberately first: a new condition must pick displayName by name,
      // not whatever happens to head the list.
      fields: [
        { name: 'id', label: 'ID', type: 'text' },
        { name: 'displayName', label: 'Name', type: 'text' },
        { name: 'email', label: 'Email', type: 'text' },
        { name: 'userType', label: 'User type', type: 'enum', values: ['Guest', 'Member'] },
        { name: 'accountEnabled', label: 'Enabled', type: 'boolean' },
        { name: 'groupCount', label: 'Group count', type: 'number' },
        { name: 'createdDateTime', label: 'Created', type: 'date' },
      ],
      relations: [
        { name: 'manager', label: 'Manager', target: 'user', cardinality: 'one' },
        { name: 'memberOf', label: 'Member of groups', target: 'group', cardinality: 'many' },
      ],
      columns: [
        { key: 'displayName', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'compare.similarity', label: 'Similarity %' },
      ],
    },
    group: {
      label: 'Group',
      table: 'Resources',
      defaultColumns: ['displayName', 'memberCount'],
      compareRelations: ['members'],
      fields: [
        { name: 'displayName', label: 'Name', type: 'text' },
        { name: 'memberCount', label: 'Member count', type: 'number' },
      ],
      relations: [{ name: 'members', label: 'Members', target: 'user', cardinality: 'many' }],
      columns: [
        { key: 'displayName', label: 'Name' },
        { key: 'memberCount', label: 'Member count' },
        { key: 'compare.shared', label: 'Shared' },
      ],
    },
  },
};

const field = (name, op, value) => ({ type: 'field', field: name, op, value });
/** The spec the editor is handed, and the shape every reported change keeps. */
const S = (conditions, over = {}) => ({ entity: 'user', match: 'all', columns: ['displayName'], conditions, ...over });

// The editor is controlled, so the harness owns the spec: each reported change
// is both recorded and fed back in, the way ReportBuilderPage does it.
function render(spec) {
  const onChange = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(spec);
    return <SpecEditor spec={current} catalog={CATALOG} onChange={(next) => { onChange(next); setCurrent(next); }} />;
  }
  renderWithProviders(<Harness />);
  return onChange;
}

const last = (onChange) => onChange.mock.lastCall[0];
const combo = (name) => screen.getByRole('combobox', { name });
/** The one relation row, so its sentence is read apart from the root's. */
const relationRow = () => combo('Has or has not').closest('div');
/** Pick the option by the label the analyst reads, so a swapped value fails. */
const pick = async (name, optionLabel) => {
  const select = combo(name);
  await userEvent.selectOptions(select, within(select).getByRole('option', { name: optionLabel }));
};

describe('SpecEditor', () => {
  it('renders a text condition as field/operator/value and reports the typed value', async () => {
    const onChange = render(S([field('displayName', 'contains', '')]));

    expect(combo('Field')).toHaveValue('displayName');
    expect(combo('Operator')).toHaveValue('contains');
    expect(screen.getByRole('option', { name: 'contains', selected: true })).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Name value' }), 'Fortigi');
    expect(last(onChange)).toEqual(S([field('displayName', 'contains', 'Fortigi')]));
  });

  it('reports the operator picked for a condition', async () => {
    const onChange = render(S([field('displayName', 'contains', 'Fortigi')]));
    await pick('Operator', 'is not');
    expect(onChange).toHaveBeenCalledWith(S([field('displayName', 'neq', 'Fortigi')]));
  });

  it('keeps the operator when the new field type still allows it, and seeds a value for that type', async () => {
    const onChange = render(S([field('displayName', 'eq', 'Wim')]));

    // text 'eq' is also an enum operator, so it survives; the value cannot.
    await pick('Field', 'User type');
    expect(onChange).toHaveBeenCalledWith(S([field('userType', 'eq', 'Guest')]));

    // enum 'eq' is also a boolean operator; a boolean condition starts at true.
    await pick('Field', 'Enabled');
    expect(last(onChange)).toEqual(S([field('accountEnabled', 'eq', true)]));
  });

  it('falls back to the new type\'s first operator when it cannot keep the current one', async () => {
    const onChange = render(S([field('displayName', 'contains', 'Fortigi')]));
    await pick('Field', 'Created');
    // 'contains' is meaningless for a date, so the date list's head takes over.
    expect(onChange).toHaveBeenCalledWith(S([field('createdDateTime', 'withinLastDays', '')]));
  });

  it('shows no value control for an operator that needs no value', () => {
    render(S([field('displayName', 'isEmpty', '')]));
    expect(combo('Operator')).toHaveValue('isEmpty');
    expect(screen.queryByRole('textbox', { name: 'Name value' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Name value' })).not.toBeInTheDocument();
  });

  it('reports a number condition as a number, and an emptied box as empty rather than zero', async () => {
    const onChange = render(S([field('groupCount', 'gt', 3)]));
    const box = screen.getByRole('spinbutton', { name: 'Group count value' });

    await userEvent.clear(box);
    expect(onChange).toHaveBeenCalledWith(S([field('groupCount', 'gt', '')]));

    await userEvent.type(box, '5');
    expect(last(onChange)).toEqual(S([field('groupCount', 'gt', 5)]));
  });

  it('counts days for a date condition in a number box', async () => {
    const onChange = render(S([field('createdDateTime', 'withinLastDays', '')]));
    const box = screen.getByRole('spinbutton', { name: 'Created value' });
    expect(box).toHaveAttribute('type', 'number');

    await userEvent.type(box, '30');
    expect(last(onChange)).toEqual(S([field('createdDateTime', 'withinLastDays', 30)]));
  });

  it('reports a boolean condition as a boolean, not as the string the select carries', async () => {
    const onChange = render(S([field('accountEnabled', 'eq', true)]));
    expect(combo('Enabled value')).toHaveValue('true');

    await pick('Enabled value', 'No');
    expect(onChange).toHaveBeenCalledWith(S([field('accountEnabled', 'eq', false)]));
  });

  it('offers the catalog values for an enum condition and keeps an unknown value selectable', async () => {
    // A value the data no longer has must stay visible — otherwise the select
    // would silently show 'Guest' while the spec still says 'Contractor'.
    const onChange = render(S([field('userType', 'eq', 'Contractor')]));
    const select = combo('User type value');
    expect(select).toHaveValue('Contractor');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['Contractor', 'Guest', 'Member']);

    await pick('User type value', 'Member');
    expect(onChange).toHaveBeenCalledWith(S([field('userType', 'eq', 'Member')]));
  });

  it('adds a condition on the report entity using its name field and first operator', async () => {
    const onChange = render(S([]));
    await userEvent.click(screen.getByRole('button', { name: '+ condition' }));
    expect(onChange).toHaveBeenCalledWith(S([field('displayName', 'eq', '')]));
  });

  it('adds a related condition for the relation picked from the dropdown', async () => {
    const onChange = render(S([]));
    await pick('Add related condition', 'Member of groups');
    expect(onChange).toHaveBeenCalledWith(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [] },
    ]));
  });

  it('adds an any/all group seeded with one condition, and offers no group inside a group', async () => {
    const onChange = render(S([]));
    await userEvent.click(screen.getByRole('button', { name: '+ any/all group' }));
    expect(onChange).toHaveBeenCalledWith(S([
      { type: 'group', match: 'any', conditions: [field('displayName', 'eq', '')] },
    ]));
    // Groups do not nest: the one button on screen is still the root's.
    expect(screen.getAllByRole('button', { name: '+ any/all group' })).toHaveLength(1);
  });

  it('removes only the condition whose ✕ was clicked', async () => {
    const onChange = render(S([field('displayName', 'eq', 'a'), field('groupCount', 'gt', 3)]));
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[1]);
    expect(onChange).toHaveBeenCalledWith(S([field('displayName', 'eq', 'a')]));
  });

  it('reports the all/any the analyst picked for the whole report', async () => {
    const conditions = [field('displayName', 'eq', 'a'), field('groupCount', 'gt', 3)];
    const onChange = render(S(conditions));
    expect(screen.getByText('matching')).toBeInTheDocument();

    await pick('Match', 'any');
    expect(onChange).toHaveBeenCalledWith(S(conditions, { match: 'any' }));
  });

  it('hides the all/any match while a single condition needs no combining', () => {
    render(S([field('displayName', 'eq', 'a')]));
    expect(screen.queryByRole('combobox', { name: 'Match' })).not.toBeInTheDocument();
    expect(screen.getByText('where')).toBeInTheDocument();
  });

  it('edits a relation condition against the related entity, not the report entity', async () => {
    const onChange = render(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [field('memberCount', 'gt', 0)] },
    ]));
    expect(within(relationRow()).getByText('Member of groups')).toBeInTheDocument();
    expect(within(relationRow()).getByText('where')).toBeInTheDocument();

    // The nested field list is the group's, so the user-only fields are absent.
    const nested = combo('Field');
    expect(within(nested).getByRole('option', { name: 'Member count' })).toBeInTheDocument();
    expect(within(nested).queryByRole('option', { name: 'Enabled' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('spinbutton', { name: 'Member count value' }), '5');
    expect(last(onChange)).toEqual(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [field('memberCount', 'gt', 5)] },
    ]));
  });

  it('reports "has no" as the none quantifier and "has" as some', async () => {
    const onChange = render(S([{ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [] }]));
    expect(within(relationRow()).queryByText('where')).not.toBeInTheDocument(); // nothing to qualify yet

    await pick('Has or has not', 'has no');
    expect(onChange).toHaveBeenCalledWith(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'none', match: 'all', conditions: [] },
    ]));

    // Both directions: a mislabelled option only shows when it is the one picked.
    await pick('Has or has not', 'has');
    expect(last(onChange)).toEqual(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [] },
    ]));
  });

  it('adds a condition on the related entity when asked', async () => {
    const onChange = render(S([{ type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [] }]));
    await userEvent.click(screen.getByRole('button', { name: '+ condition on member of groups' }));
    expect(onChange).toHaveBeenCalledWith(S([
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [field('displayName', 'eq', '')] },
    ]));
    // …and it is the group's field list, not the report entity's.
    const nested = combo('Field');
    expect(within(nested).getByRole('option', { name: 'Member count' })).toBeInTheDocument();
    expect(within(nested).queryByRole('option', { name: 'Group count' })).not.toBeInTheDocument();
  });

  it('offers the relation its own all/any only once it has more than one condition', async () => {
    const one = { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [field('memberCount', 'gt', 0)] };
    const onChange = render(S([one]));
    expect(screen.queryByRole('combobox', { name: 'Relation match' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+ condition on member of groups' }));
    const two = [field('memberCount', 'gt', 0), field('displayName', 'eq', '')];
    await pick('Relation match', 'any');
    expect(last(onChange)).toEqual(S([{ ...one, match: 'any', conditions: two }]));
  });

  it('combines the conditions inside a group with the group\'s own all/any', async () => {
    const conditions = [field('displayName', 'eq', 'a'), field('groupCount', 'gt', 3)];
    const onChange = render(S([{ type: 'group', match: 'any', conditions }]));
    // A group stays on the report entity, so its fields are the user's.
    expect(within(screen.getAllByRole('combobox', { name: 'Field' })[0]).getByRole('option', { name: 'Group count' })).toBeInTheDocument();

    await pick('Group match', 'all');
    expect(onChange).toHaveBeenCalledWith(S([{ type: 'group', match: 'all', conditions }]));
  });

  it('hands a comparison to CompareCondition, wired to the shared remove button', async () => {
    const compare = { type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'user', name: '' } };
    const onChange = render(S([compare]));

    // CompareCondition's own row, driven by the catalog SpecEditor handed it.
    expect(combo('Comparison')).toHaveValue('identical');
    expect(within(combo('Comparison')).getByRole('option', { name: 'exactly the same' })).toBeInTheDocument();
    expect(combo('Compared relation')).toHaveValue('memberOf');
    expect(screen.getByLabelText('Reference name')).toBeInTheDocument();
    // The comparison columns only make sense now, so they are offered.
    expect(screen.getByRole('button', { name: 'Similarity %' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove condition' }));
    expect(onChange).toHaveBeenCalledWith(S([]));
  });

  it('hides the comparison columns while the report compares nothing', () => {
    render(S([field('displayName', 'eq', 'a')]));
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Similarity %' })).not.toBeInTheDocument();
  });

  it('offers the comparison columns when the comparison sits inside a group', () => {
    const compare = { type: 'compare', relation: 'memberOf', measure: 'identical', reference: { entity: 'user', name: '' } };
    render(S([{ type: 'group', match: 'any', conditions: [compare] }]));
    expect(screen.getByRole('button', { name: 'Similarity %' })).toBeInTheDocument();
  });

  it('adds and removes a column as its chip is clicked', async () => {
    const onChange = render(S([], { columns: ['displayName'] }));
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Email' })).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Email' }));
    expect(onChange).toHaveBeenCalledWith(S([], { columns: ['displayName', 'email'] }));

    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(last(onChange)).toEqual(S([], { columns: ['email'] }));
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts over with the new entity\'s default columns when the report subject changes', async () => {
    const onChange = render(S([field('displayName', 'eq', 'a')], { match: 'any' }));
    expect(within(combo('Report on')).getByRole('option', { name: 'Users', selected: true })).toBeInTheDocument();

    await pick('Report on', 'Groups');
    expect(onChange).toHaveBeenCalledWith({ entity: 'group', match: 'all', conditions: [], columns: ['displayName', 'memberCount'] });
    // A copy — the spec must never hand back the catalog's own array to mutate.
    expect(last(onChange).columns).not.toBe(CATALOG.entities.group.defaultColumns);
    expect(screen.getByRole('button', { name: 'Member count' })).toHaveAttribute('aria-pressed', 'true');
  });
});
