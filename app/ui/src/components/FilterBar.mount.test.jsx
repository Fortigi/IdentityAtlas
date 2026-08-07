// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import FilterBar from '@ui/components/FilterBar';

describe('FilterBar active pill (issue #943)', () => {
  it('displays the actual active value even when it is missing from the options list', () => {
    // #943: the tag "HaMIS (te controleren groepen)" was created and assigned
    // AFTER the column-discovery snapshot was fetched, so the options list only
    // holds stale tags. A controlled <select> whose value matches no <option>
    // keeps selectedIndex 0, so the browser silently displays the first option
    // ("Adobe Licenties") while the real active filter is something else.
    renderWithProviders(
      <FilterBar
        label="Filters:"
        filterFields={[{ key: '__resourceTag', label: 'Resource Tag' }]}
        activeFilters={[{ field: '__resourceTag', value: 'HaMIS (te controleren groepen)' }]}
        getOptionsForField={() => ['Adobe Licenties', 'Sensitive']}
        onAddFilter={() => {}}
        onRemoveFilter={() => {}}
      />
    );

    expect(screen.getByRole('combobox')).toHaveValue('HaMIS (te controleren groepen)');
  });
});
