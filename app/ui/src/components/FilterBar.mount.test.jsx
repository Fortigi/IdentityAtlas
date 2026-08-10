// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, within } from '@ui/test-utils/renderWithProviders';
import FilterBar from '@ui/components/FilterBar';

const noop = () => {};

// Every test here mounts the same bar and varies two or three props. Inlining the
// full prop list each time made three of these blocks byte-identical, which the
// jscpd duplication gate counts as new clones. One helper, overrides per test.
function renderBar(props = {}) {
  return renderWithProviders(
    <FilterBar
      label="Filters:"
      filterFields={[]}
      activeFilters={[]}
      getOptionsForField={() => []}
      onAddFilter={noop}
      onRemoveFilter={noop}
      {...props}
    />
  );
}

const DEPARTMENT_FIELD = [{ key: 'department', label: 'Department' }];
const TAG_FIELD = [{ key: '__resourceTag', label: 'Resource Tag' }];

describe('FilterBar active pill (issue #943)', () => {
  it('displays the actual active value even when it is missing from the options list', () => {
    // #943: the tag "HaMIS (te controleren groepen)" was created and assigned
    // AFTER the column-discovery snapshot was fetched, so the options list only
    // holds stale tags. A controlled <select> whose value matches no <option>
    // keeps selectedIndex 0, so the browser silently displays the first option
    // ("Adobe Licenties") while the real active filter is something else.
    renderBar({
      filterFields: TAG_FIELD,
      activeFilters: [{ field: '__resourceTag', value: 'HaMIS (te controleren groepen)' }],
      getOptionsForField: () => ['Adobe Licenties', 'Sensitive'],
    });

    expect(screen.getByRole('combobox')).toHaveValue('HaMIS (te controleren groepen)');
  });

  it('does not duplicate the active value when it is already a known option', () => {
    renderBar({
      filterFields: TAG_FIELD,
      activeFilters: [{ field: '__resourceTag', value: 'Sensitive' }],
      getOptionsForField: () => ['Adobe Licenties', 'Sensitive'],
    });

    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('Sensitive');
    expect(within(select).getAllByRole('option').map(o => o.textContent))
      .toEqual(['Adobe Licenties', 'Sensitive']);
  });

  it('still renders a pill for an active filter whose field has not been discovered yet', () => {
    // Sibling symptom of #943: column discovery only surfaces a field once it
    // has values, so the first tag of a session filters the table while its
    // field is absent from filterFields. The pill must still appear — otherwise
    // the filter is active but invisible and cannot be cleared.
    const onRemoveFilter = vi.fn();
    renderBar({
      activeFilters: [{ field: '__resourceTag', value: 'ZZZ-Second' }],
      onRemoveFilter,
    });

    expect(screen.getByText('__resourceTag:')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('ZZZ-Second');

    fireEvent.click(screen.getByTitle('Remove filter'));
    expect(onRemoveFilter).toHaveBeenCalledWith('__resourceTag');
  });

  it('switching an active pill to another value re-applies the filter', () => {
    const onAddFilter = vi.fn();
    renderBar({
      filterFields: DEPARTMENT_FIELD,
      activeFilters: [{ field: 'department', value: 'Sales' }],
      getOptionsForField: () => ['Sales', 'Engineering'],
      onAddFilter,
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Engineering' } });
    expect(onAddFilter).toHaveBeenCalledWith('department', 'Engineering');
  });
});

describe('FilterBar add/clear controls', () => {
  it('adds a filter through the inline field + value pickers', () => {
    const onAddFilter = vi.fn();
    renderBar({
      filterFields: DEPARTMENT_FIELD,
      getOptionsForField: () => ['Sales', 'Engineering'],
      onAddFilter,
    });

    fireEvent.click(screen.getByText('+ Add filter'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'department' } });
    const [, valueSelect] = screen.getAllByRole('combobox');
    fireEvent.change(valueSelect, { target: { value: 'Sales' } });

    expect(onAddFilter).toHaveBeenCalledWith('department', 'Sales');
    // Picker closes again after a value is chosen.
    expect(screen.getByText('+ Add filter')).toBeInTheDocument();
  });

  it('cancelling the inline picker adds nothing', () => {
    const onAddFilter = vi.fn();
    renderBar({
      filterFields: DEPARTMENT_FIELD,
      getOptionsForField: () => ['Sales'],
      onAddFilter,
    });

    fireEvent.click(screen.getByText('+ Add filter'));
    fireEvent.click(screen.getByText('×'));
    expect(onAddFilter).not.toHaveBeenCalled();
    expect(screen.getByText('+ Add filter')).toBeInTheDocument();
  });

  it('shows a loading hint instead of the add button while columns are still being fetched', () => {
    renderBar({ loading: true });

    expect(screen.getByText(/Loading filters/i)).toBeInTheDocument();
    expect(screen.queryByText('+ Add filter')).not.toBeInTheDocument();
  });

  it('Clear all removes every active filter shown by the bar', () => {
    const onRemoveFilter = vi.fn();
    renderBar({
      filterFields: [...DEPARTMENT_FIELD, ...TAG_FIELD],
      activeFilters: [
        { field: 'department', value: 'Sales' },
        { field: '__resourceTag', value: 'ZZZ-Second' },
      ],
      getOptionsForField: () => ['Sales'],
      onRemoveFilter,
    });

    fireEvent.click(screen.getByTitle('Clear all filters'));
    expect(onRemoveFilter).toHaveBeenCalledWith('department');
    expect(onRemoveFilter).toHaveBeenCalledWith('__resourceTag');
  });
});
