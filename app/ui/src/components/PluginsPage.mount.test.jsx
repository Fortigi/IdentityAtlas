// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import PluginsPage from './PluginsPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const tree = {
  algorithmId: 'manager-hierarchy',
  instanceKey: 'default',
  algo: 'manager-hierarchy',
  algoDisplayName: 'Manager Hierarchy',
  rootName: 'Org Chart',
  targetType: 'Identity',
  contextCount: 42,
  lastStatus: 'succeeded',
  lastRunAt: '2026-06-01T10:00:00Z',
  lastRunBy: 'system',
  params: { rootName: 'Org Chart', depth: 5 },
};

const plugin = {
  name: 'manager-hierarchy',
  displayName: 'Manager Hierarchy',
  description: 'Builds a tree from manager links.',
  parametersSchema: {
    properties: {
      depth: { type: 'integer', title: 'Depth', description: 'levels deep' },
      mode: { enum: ['a', 'b'], title: 'Mode' },
      enabled: { type: 'boolean', title: 'Enabled' },
      tags: { type: 'array', title: 'Tags' },
      label: { type: 'string', title: 'Label' },
    },
  },
};

function routes(overrides = {}) {
  return makeAuthFetch({
    'context-plugins/trees': { data: [tree] },
    'context-plugins': { data: [plugin] },
    ...overrides,
  });
}

describe('PluginsPage (mounted)', () => {
  it('loads and lists configured plugin trees', async () => {
    renderWithProviders(h(PluginsPage), { auth: { authFetch: routes() } });

    // List populates only after the mount-effect fetch resolves.
    expect(await screen.findByText('Org Chart')).toBeInTheDocument();
    expect(screen.getByText('Manager Hierarchy')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
  });

  it('shows the empty state when no trees are configured', async () => {
    renderWithProviders(h(PluginsPage), { auth: { authFetch: routes({ 'context-plugins/trees': { data: [] } }) } });
    expect(await screen.findByText(/No context plugins configured yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    const authFetch = makeAuthFetch({
      'context-plugins/trees': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
      'context-plugins': { data: [] },
    });
    renderWithProviders(h(PluginsPage), { auth: { authFetch } });
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });

  it('opens a tree detail with a config form rendered from the schema', async () => {
    renderWithProviders(h(PluginsPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await user.click(await screen.findByText('Org Chart'));

    // Detail view: description + every FieldInput variant from the schema.
    expect(await screen.findByText('What it does')).toBeInTheDocument();
    expect(screen.getByText('Builds a tree from manager links.')).toBeInTheDocument();
    for (const label of ['Depth', 'Mode', 'Enabled', 'Tags', 'Label']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The integer field is pre-filled from the tree's params (depth: 5).
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
  });

  it('re-runs the plugin when Save & re-run is clicked', async () => {
    const authFetch = routes();
    renderWithProviders(h(PluginsPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await user.click(await screen.findByText('Org Chart'));
    await user.click(await screen.findByText('Save & re-run'));

    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/run'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByText(/rebuilding the tree/i)).toBeInTheDocument();
  });
});
