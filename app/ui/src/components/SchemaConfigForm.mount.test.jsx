// @vitest-environment jsdom
//
// The schema-driven form shared by context plugins and parameterised reports:
// one labelled field per JSON-schema property, typed by the property, with the
// caller owning the values.

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import SchemaConfigForm, { FieldInput } from '@ui/components/SchemaConfigForm';

const SCHEMA = {
  properties: {
    mode: { type: 'string', title: 'Mode', enum: ['fast', 'thorough'], description: 'How hard to look.' },
    enabled: { type: 'boolean', title: 'Enabled' },
    inactiveDays: { type: 'integer', title: 'Inactive days' },
    ratio: { type: 'number' },
    systems: { type: 'array', title: 'Systems' },
    label: { type: 'string', title: 'Label' },
  },
};

function renderForm(params = {}, props = {}) {
  const onChange = vi.fn();
  const utils = renderWithProviders(
    <SchemaConfigForm schema={SCHEMA} params={params} onChange={onChange} {...props} />,
  );
  return { onChange, ...utils };
}

describe('SchemaConfigForm — empty schema', () => {
  it('shows the caller-worded hint when the schema has no properties', () => {
    renderWithProviders(<SchemaConfigForm schema={{ properties: {} }} params={{}} onChange={() => {}}
      emptyHint="This report has no parameters." />);
    expect(screen.getByText('This report has no parameters.')).toBeInTheDocument();
  });

  it('renders nothing without a hint, and treats a missing schema as empty', () => {
    const { container } = renderWithProviders(<SchemaConfigForm params={{}} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SchemaConfigForm — fields', () => {
  it('labels each field with its title, falling back to the property key', () => {
    renderForm();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Enabled/ })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Inactive days' })).toBeInTheDocument();
    // No title → the key itself is the label.
    expect(screen.getByRole('spinbutton', { name: 'ratio' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Systems' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Label' })).toBeInTheDocument();
  });

  it('shows a description only for properties that declare one', () => {
    const { container } = renderForm();
    expect(screen.getByText('How hard to look.')).toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  it('prefixes ids with idPrefix so two forms on a page do not collide', () => {
    renderForm({}, { idPrefix: 'report' });
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveAttribute('id', 'report-label');
  });

  it('uses "param" as the default id prefix', () => {
    renderForm();
    expect(screen.getByRole('spinbutton', { name: 'Inactive days' })).toHaveAttribute('id', 'param-inactiveDays');
  });

  it('shows the current values in each field type', () => {
    renderForm({ mode: 'thorough', enabled: true, inactiveDays: 45, systems: ['Entra ID', 'Omada'], label: 'Q3' });
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveValue('thorough');
    expect(screen.getByRole('checkbox', { name: /Enabled/ })).toBeChecked();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Inactive days' })).toHaveValue(45);
    expect(screen.getByRole('textbox', { name: 'Systems' })).toHaveValue('Entra ID, Omada');
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Q3');
  });

  it('shows empty fields and "Off" when nothing is set', () => {
    renderForm();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: /Enabled/ })).not.toBeChecked();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Inactive days' })).toHaveValue(null);
    expect(screen.getByRole('textbox', { name: 'Systems' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('');
  });

  it('shows a legacy string value in an array field verbatim', () => {
    renderForm({ systems: 'Entra ID' });
    expect(screen.getByRole('textbox', { name: 'Systems' })).toHaveValue('Entra ID');
  });
});

describe('SchemaConfigForm — onChange', () => {
  // Every change must carry the other params along — a form that sent only the
  // edited key would silently reset the rest.
  const EXISTING = { label: 'keep me', inactiveDays: 10 };

  it('select: sends the chosen option, and undefined for "none"', () => {
    const { onChange } = renderForm({ ...EXISTING, mode: 'fast' });
    const select = screen.getByRole('combobox', { name: 'Mode' });
    fireEvent.change(select, { target: { value: 'thorough' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, mode: 'thorough' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, mode: undefined });
  });

  it('checkbox: sends the boolean checked state', () => {
    const { onChange } = renderForm({ ...EXISTING, enabled: false });
    fireEvent.click(screen.getByRole('checkbox', { name: /Enabled/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, enabled: true });
  });

  it('checkbox: unchecking sends false, not undefined', () => {
    const { onChange } = renderForm({ ...EXISTING, enabled: true });
    fireEvent.click(screen.getByRole('checkbox', { name: /Enabled/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, enabled: false });
  });

  it('number: sends a Number (not the string), and undefined when cleared', () => {
    const { onChange } = renderForm({ ...EXISTING });
    const input = screen.getByRole('spinbutton', { name: 'ratio' });
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, ratio: 0.5 });
    fireEvent.change(input, { target: { value: '0' } });
    // 0 is a value, not "cleared".
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, ratio: 0 });

    const days = screen.getByRole('spinbutton', { name: 'Inactive days' });
    fireEvent.change(days, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ label: 'keep me', inactiveDays: undefined });
  });

  it('array: splits on commas, trims, and drops empty entries', () => {
    const { onChange } = renderForm({ ...EXISTING });
    fireEvent.change(screen.getByRole('textbox', { name: 'Systems' }), { target: { value: ' Entra ID ,, Omada,' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EXISTING, systems: ['Entra ID', 'Omada'] });
  });

  it('text: sends the typed string, and undefined when cleared', () => {
    const { onChange } = renderForm({ inactiveDays: 10, label: 'old' });
    const input = screen.getByRole('textbox', { name: 'Label' });
    fireEvent.change(input, { target: { value: 'new' } });
    expect(onChange).toHaveBeenLastCalledWith({ inactiveDays: 10, label: 'new' });
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ inactiveDays: 10, label: undefined });
  });
});

describe('FieldInput', () => {
  it('renders an enum as a select even when the type says integer', () => {
    const onChange = vi.fn();
    renderWithProviders(<FieldInput id="tier" prop={{ type: 'integer', enum: [0, 1, 2] }} value={1} onChange={onChange} />);
    const select = screen.getByRole('combobox');
    expect([...select.options].map((o) => o.textContent)).toEqual(['— none —', '0', '1', '2']);
    expect(select).toHaveValue('1');
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('renders a property with no type as a text box', () => {
    const onChange = vi.fn();
    renderWithProviders(<FieldInput id="free" prop={{}} value="abc" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('id', 'free');
    expect(input).toHaveValue('abc');
  });
});
