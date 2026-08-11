// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import PowerQueryExportSection from './PowerQueryExportSection';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';

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

  it('renders no table when there are no tokens yet', async () => {
    const { container } = renderWithProviders(h(PowerQueryExportSection), {
      auth: { authFetch: routes({ '/api/admin/read-tokens': [] }) },
    });
    await openSection();

    expect(await screen.findByText('No tokens issued yet.')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });
});
