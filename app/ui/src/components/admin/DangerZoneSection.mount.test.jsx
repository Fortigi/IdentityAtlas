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

// The plan the API serves (shape of GET /api/admin/clean-database/plan). The
// texts are deliberately not the real ones: the dialog must show whatever the
// server says, not copy of its own.
const PLAN = {
  confirmation: 'DELETE ALL DATA',
  removed: [{ key: 'source', text: 'Plan says: crawled accounts go', tables: ['Principals'] }],
  kept: [{ key: 'manual', text: 'Plan says: manual tags stay', tables: ['Contexts'] }],
  alsoRemoved: [{ what: 'Plan says: manager overrides', because: 'the account is removed', tables: ['ManagerHierarchyOverrides'] }],
  keptButChanged: [{ what: 'Plan says: crawler configs show never run', tables: ['CrawlerConfigs'] }],
};

const routes = (cleanResult) => (url) => {
  if (String(url).includes('/clean-database/plan')) return PLAN;
  if (String(url).includes('/api/admin/clean-database')) return cleanResult;
  return undefined;
};

async function confirmAndClean(user) {
  await user.click(screen.getByRole('button', { name: 'Clean Database' }));
  await user.click(await screen.findByRole('button', { name: 'Yes, continue' }));
  await user.type(screen.getByPlaceholderText('DELETE ALL DATA'), 'DELETE ALL DATA');
  await user.click(screen.getByRole('button', { name: 'Clean Database' }));
}

describe('DangerZoneSection', () => {
  it('shows what the API says a clean removes and keeps, with a backup link for this version', async () => {
    renderWithProviders(h(DangerZoneSection, { version: '6.93.20261117.0846' }), { auth: { authFetch: makeAuthFetch(routes({})) } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));

    expect(await screen.findByText('Plan says: crawled accounts go')).toBeInTheDocument();
    expect(screen.getByText('Plan says: manual tags stay')).toBeInTheDocument();
    expect(screen.getByText('Plan says: manager overrides — the account is removed.')).toBeInTheDocument();
    expect(screen.getByText('Plan says: crawler configs show never run.')).toBeInTheDocument();
    const backup = screen.getByRole('link', { name: 'Make a backup first' });
    expect(backup).toHaveAttribute('href', 'https://docs.identityatlas.io/edge/admin/backup-restore-upgrade/');
    expect(screen.getByRole('button', { name: 'Yes, continue' })).toBeEnabled();
  });

  it('leaves out the two optional lists when the plan has nothing in them', async () => {
    const bare = { ...PLAN, alsoRemoved: [], keptButChanged: [] };
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch: makeAuthFetch(() => bare) } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));
    expect(await screen.findByText('Plan says: crawled accounts go')).toBeInTheDocument();
    expect(screen.queryByText(/removed anyway/)).not.toBeInTheDocument();
    expect(screen.queryByText('Kept, but changed')).not.toBeInTheDocument();
  });

  it('cannot be confirmed when the plan does not load', async () => {
    const authFetch = makeAuthFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 403 }));
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));

    expect(await screen.findByText(/Could not load what a clean removes \(HTTP 403\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, continue' })).toBeDisabled();
  });

  it('cannot be confirmed when the plan is not the expected shape', async () => {
    const authFetch = makeAuthFetch(() => ({ removed: [], kept: [] }));
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));

    expect(await screen.findByText(/Could not load what a clean removes \(unexpected answer\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, continue' })).toBeDisabled();
  });

  it('sends the explicit confirmation body the API requires (SEC-2026-09 H-07) and reports what went', async () => {
    const onRefresh = vi.fn();
    const authFetch = makeAuthFetch(routes({
      message: 'Database cleaned',
      wiped: [{ table: 'Principals', rowsAffected: 3 }, { table: 'Systems', rowsAffected: 1 }],
      alsoRemoved: [{ table: 'SystemOwners', rowsAffected: 2 }],
      historyRowsRemoved: 7,
    }));
    renderWithProviders(h(DangerZoneSection, { onRefresh }), { auth: { authFetch } });
    const user = userEvent.setup();

    await confirmAndClean(user);

    expect(await screen.findByText('Database cleaned')).toBeInTheDocument();
    expect(screen.getByText(/Cleaned 2 tables; 1 kept table lost rows that hung on removed data/)).toBeInTheDocument();
    expect(screen.getByText('SystemOwners')).toBeInTheDocument();
    const [url, opts] = authFetch.mock.calls.find(([u, o]) => String(u).includes('clean-database') && o?.method === 'POST');
    expect(url).toBe('/api/admin/clean-database');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ confirm: 'DELETE ALL DATA' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the final button disabled until the exact phrase is typed', async () => {
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch: makeAuthFetch(routes({})) } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, continue' }));
    await user.type(screen.getByPlaceholderText('DELETE ALL DATA'), 'delete all data');
    expect(screen.getByRole('button', { name: 'Clean Database' })).toBeDisabled();
  });

  it('shows the server error when the clean fails', async () => {
    const authFetch = makeAuthFetch((url) => String(url).includes('/plan')
      ? PLAN
      : jsonResponse({ error: 'Clean database failed. Nothing was removed.' }, { ok: false, status: 500 }));
    renderWithProviders(h(DangerZoneSection, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await confirmAndClean(user);

    expect(await screen.findByText('Clean database failed. Nothing was removed.')).toBeInTheDocument();
  });
});
