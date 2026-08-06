// @vitest-environment jsdom
//
// Guards #928: a column with more distinct values than the API can preload is
// served as a flagged, alphabetically-first page. The picker must therefore
// (a) say the count is a floor, and (b) let the user search — locally over the
// preloaded page, and server-side for a truncated column so values off the end
// of the page are still selectable.

import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AttributePicker from './AttributePicker';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, fireEvent, waitFor, userEvent,
} from '@ui/test-utils/renderWithProviders';

const TARGET = 'Zzz — the description the wizard could not find';

const columns = [
  { column: 'displayName', values: ['ignored'] },
  { column: 'resourceType', values: ['Group', 'Application'], truncated: false },
  { column: 'description', values: ['Alpha team', 'Beta team'], truncated: true },
];

function renderPicker({ onPick = vi.fn(), onClose = vi.fn(), search = [] } = {}) {
  const authFetch = makeAuthFetch((url) => {
    if (String(url).includes('/api/matrix/column-values')) {
      return jsonResponse({ column: 'description', values: search, truncated: false });
    }
    return undefined;
  });
  renderWithProviders(
    h(AttributePicker, { entity: 'Resource', columns, onPick, onClose }),
    { auth: { authFetch } },
  );
  return { authFetch, onPick, onClose };
}

describe('AttributePicker value search (#928)', () => {
  it('marks a truncated column with a "+" so its count reads as a floor', () => {
    renderPicker();
    const select = screen.getByRole('combobox', { name: /field/i });
    const labels = Array.from(select.options).map(o => o.textContent);
    expect(labels).toContain('description (2+)');
    expect(labels).toContain('resourceType (2)');
  });

  it('filters the preloaded values client-side as you type', async () => {
    renderPicker();
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('combobox', { name: /field/i }), { target: { value: 'description' } });

    expect(await screen.findByRole('checkbox', { name: /Alpha team/ })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /search values/i }), 'Beta');

    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Alpha team/ })).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: /Beta team/ })).toBeInTheDocument();
  });

  it('finds a value outside the preloaded page and lets it be picked', async () => {
    const { authFetch, onPick } = renderPicker({ search: [TARGET] });
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('combobox', { name: /field/i }), { target: { value: 'description' } });

    // The picker tells the user the list is incomplete.
    expect(await screen.findByText(/search to find any of them/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /search values/i }), { target: { value: 'could not find' } });

    const found = await screen.findByRole('checkbox', { name: new RegExp('could not find') }, { timeout: 2000 });
    await user.click(found);
    await user.click(screen.getByText('Add'));

    expect(onPick).toHaveBeenCalledWith('description', [TARGET]);
    expect(authFetch).toHaveBeenCalledWith(
      '/api/matrix/column-values?entity=Resource&column=description&q=could%20not%20find',
    );
  });

  it('does not query the server for a column that is not truncated', async () => {
    const { authFetch } = renderPicker();
    fireEvent.change(screen.getByRole('combobox', { name: /field/i }), { target: { value: 'resourceType' } });
    fireEvent.change(await screen.findByRole('textbox', { name: /search values/i }), { target: { value: 'Group' } });

    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Group/ })).toBeInTheDocument());
    expect(authFetch.mock.calls.filter(c => String(c[0]).includes('column-values'))).toHaveLength(0);
  });

  it('keeps an already-ticked value visible after the search term changes', async () => {
    renderPicker();
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('combobox', { name: /field/i }), { target: { value: 'description' } });
    await user.click(await screen.findByRole('checkbox', { name: /Alpha team/ }));

    fireEvent.change(screen.getByRole('textbox', { name: /search values/i }), { target: { value: 'Beta' } });

    expect(await screen.findByRole('checkbox', { name: /Alpha team/ })).toBeChecked();
  });
});
