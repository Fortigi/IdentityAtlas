// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import SystemsPage from './SystemsPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const systems = [
  {
    id: 'sys-entra',
    displayName: 'Contoso Entra',
    systemType: 'EntraID',
    enabled: true,
    principalCount: 1200,
    resourceCount: 340,
    assignmentCount: 5600,
    lastSyncDateTime: new Date(Date.now() - 5 * 60000).toISOString(),
    computedResourceTypes: ['Group', 'EntraDirectoryRole'],
    computedAssignmentTypes: ['Direct', 'Indirect'],
    owners: ['alice@example.com', 'bob@example.com'],
    description: 'Primary identity provider.',
    tenantId: 'tenant-123',
    connectionInfo: 'graph.microsoft.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'sys-csv',
    displayName: 'HR CSV Import',
    systemType: 'CSV',
    enabled: false,
    principalCount: 0,
    resourceCount: 0,
    assignmentCount: 0,
  },
];

function routes(extra = {}) {
  return makeAuthFetch({ '/api/systems': systems, ...extra });
}

describe('SystemsPage (mounted)', () => {
  it('shows the loading state before data resolves', () => {
    renderWithProviders(h(SystemsPage), { auth: { authFetch: routes() } });
    expect(screen.getByText('Loading systems...')).toBeInTheDocument();
  });

  it('lists connected systems after load', async () => {
    renderWithProviders(h(SystemsPage), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Contoso Entra')).toBeInTheDocument();
    expect(screen.getByText('HR CSV Import')).toBeInTheDocument();
    expect(screen.getByText('2 connected')).toBeInTheDocument();
    // Enabled / disabled badges
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    // Resource-type chips and owners line for the first card
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
  });

  it('expands a card to reveal detail fields when clicked', async () => {
    renderWithProviders(h(SystemsPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    const header = await screen.findByText('Contoso Entra');
    await user.click(header);

    // Expanded detail surfaces description, system id and assignment types.
    expect(await screen.findByText('Primary identity provider.')).toBeInTheDocument();
    expect(screen.getByText('sys-entra')).toBeInTheDocument();
    expect(screen.getByText('tenant-123')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
  });

  it('renders the empty state when no systems are connected', async () => {
    renderWithProviders(h(SystemsPage), { auth: { authFetch: routes({ '/api/systems': [] }) } });
    expect(await screen.findByText('No systems yet')).toBeInTheDocument();
  });

  it('renders the error state when the fetch fails', async () => {
    const authFetch = routes({ '/api/systems': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }) });
    renderWithProviders(h(SystemsPage), { auth: { authFetch } });

    expect(await screen.findByText('Error loading systems')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });
});
