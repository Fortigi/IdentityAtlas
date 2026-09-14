import { expect } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';

// Columns payload offering the virtual `__system` filter field — what the column endpoints return.
export const SYSTEM_COLUMNS = [{ column: '__system', values: ['ContosoHR', 'DemoIGA'] }];

// Drives the filter bar on a mounted list page: the virtual `__system` field must show up as
// "System" (not the raw key), and picking a system must reach the list API as a __system filter.
// `listUrls` is the array of list-request URLs the page's authFetch recorded.
export async function expectSystemFilterApplied(listUrls) {
  fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
  const fieldSelect = screen.getByRole('combobox');
  expect(within(fieldSelect).getByRole('option', { name: 'System' })).toBeInTheDocument();

  fireEvent.change(fieldSelect, { target: { value: '__system' } });
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'DemoIGA' } });

  await waitFor(() => expect(listUrls.some(u => decodeURIComponent(u).includes('"__system":"DemoIGA"'))).toBe(true));
}
