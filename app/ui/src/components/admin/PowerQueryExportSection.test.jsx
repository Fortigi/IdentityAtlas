// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import PowerQueryExportSection from './PowerQueryExportSection';
import { renderWithProviders, makeAuthFetch, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';

const tokenRow = {
  id: 't1',
  name: 'PowerBI prod report',
  tokenPrefix: 'ia_abcd',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: '2026-02-01T00:00:00Z',
  revoked: false,
  expiresAt: null,
};

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/admin/read-tokens': [tokenRow],
    ...overrides,
  });
}

async function openSection() {
  const user = userEvent.setup();
  await user.click(screen.getByText('Excel Power Query Workbook'));
  return user;
}

describe('PowerQueryExportSection', () => {
  it('lists existing tokens once expanded', async () => {
    renderWithProviders(h(PowerQueryExportSection), { auth: { authFetch: routes() } });
    await openSection();

    expect(await screen.findByText('PowerBI prod report')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('wraps the tokens table in a horizontally-scrolling container', async () => {
    const { container } = renderWithProviders(h(PowerQueryExportSection), { auth: { authFetch: routes() } });
    await openSection();

    await screen.findByText('PowerBI prod report');
    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
  });

  it('revokes a token from its row button once the confirmation is accepted', async () => {
    const { authFetch } = renderWithProviders(h(PowerQueryExportSection), { auth: { authFetch: routes() } });
    const user = await openSection();

    await screen.findByText('PowerBI prod report');
    const row = screen.getByText('PowerBI prod report').closest('tr');
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));

    // The row button and the dialog's confirm button share the label, so scope
    // the confirm click to the modal that just appeared.
    const modal = (await screen.findByText(/Workbooks using it will stop refreshing/)).closest('.fixed');
    await user.click(within(modal).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      '/api/admin/read-tokens/t1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });

  it('leaves the token alone when the revoke confirmation is cancelled', async () => {
    const { authFetch } = renderWithProviders(h(PowerQueryExportSection), { auth: { authFetch: routes() } });
    const user = await openSection();

    await screen.findByText('PowerBI prod report');
    const row = screen.getByText('PowerBI prod report').closest('tr');
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(authFetch).not.toHaveBeenCalledWith(
      '/api/admin/read-tokens/t1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('offers no revoke button for an already-revoked token', async () => {
    renderWithProviders(h(PowerQueryExportSection), {
      auth: { authFetch: routes({ '/api/admin/read-tokens': [{ ...tokenRow, revoked: true }] }) },
    });
    await openSection();

    await screen.findByText('PowerBI prod report');
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('renders no table when there are no tokens yet', async () => {
    const { container } = renderWithProviders(h(PowerQueryExportSection), {
      auth: { authFetch: routes({ '/api/admin/read-tokens': [] }) },
    });
    await openSection();

    expect(await screen.findByText('No tokens issued yet.')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });
});
