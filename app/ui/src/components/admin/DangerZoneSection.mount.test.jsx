// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import DangerZoneSection from './DangerZoneSection';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

async function confirmAndClean(user) {
  await user.click(screen.getByRole('button', { name: 'Clean Database' }));
  await user.click(await screen.findByRole('button', { name: 'Yes, continue' }));
  await user.type(screen.getByPlaceholderText('DELETE ALL DATA'), 'DELETE ALL DATA');
  await user.click(screen.getByRole('button', { name: 'Clean Database' }));
}

describe('DangerZoneSection', () => {
  it('sends the explicit confirmation body the API requires (SEC-2026-09 H-07)', async () => {
    const onRefresh = vi.fn();
    const authFetch = makeAuthFetch((url, opts) => {
      if (String(url).includes('/api/admin/clean-database')) return { message: 'Database cleaned', wiped: [{ table: 'Principals', rowsAffected: 3 }], skipped: [] };
      return undefined;
    });
    renderWithProviders(h(DangerZoneSection, { onRefresh }), { auth: { authFetch } });
    const user = userEvent.setup();

    await confirmAndClean(user);

    expect(await screen.findByText('Database cleaned')).toBeInTheDocument();
    const [url, opts] = authFetch.mock.calls.find(([u]) => String(u).includes('clean-database'));
    expect(url).toBe('/api/admin/clean-database');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ confirm: 'DELETE ALL DATA' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the final button disabled until the exact phrase is typed', async () => {
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch: makeAuthFetch({}) } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, continue' }));
    await user.type(screen.getByPlaceholderText('DELETE ALL DATA'), 'delete all data');
    expect(screen.getByRole('button', { name: 'Clean Database' })).toBeDisabled();
  });

  it('shows the server error when the wipe is refused', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'Confirmation required' }, { ok: false, status: 400 }));
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await confirmAndClean(user);

    expect(await screen.findByText('Confirmation required')).toBeInTheDocument();
  });
});
