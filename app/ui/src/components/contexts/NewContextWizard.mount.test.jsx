// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import NewContextWizard from './NewContextWizard';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const plugin = {
  name: 'manager-hierarchy',
  displayName: 'Manager Hierarchy',
  description: 'Builds a tree from manager links.',
  targetType: 'Identity',
  parametersSchema: {
    properties: {
      rootName: { type: 'string', description: 'Root label', default: 'Org Chart' },
      depth: { type: 'integer', description: 'levels deep', default: 3 },
      scopeSystemId: { type: 'integer', description: 'Scope system' },
    },
    required: ['rootName'],
  },
};

const systems = [{ id: 1, displayName: 'EntraID' }, { id: 2, displayName: 'Omada' }];

const dryRunResult = {
  contextCount: 4,
  memberCount: 12,
  samples: {
    contexts: [{ displayName: 'Engineering', externalId: 'ext-eng' }],
    members: [{ memberId: 'u1', contextExternalId: 'ext-eng' }],
  },
};

function routes(overrides = {}) {
  // Most-specific URL substrings first — makeAuthFetch matches the first key
  // that is contained in the request URL.
  return makeAuthFetch({
    'context-plugins/principal-attributes': { columns: ['department'], extended: ['costCenter'] },
    'dry-run': dryRunResult,
    '/run': { runId: 'run-99' },
    'contexts?variant=generated': { data: [] },
    'context-plugins': { data: [plugin] },
    'systems': { data: systems },
    ...overrides,
  });
}

function renderWizard(authFetch, props = {}) {
  const callbacks = {
    onClose: vi.fn(),
    onCreated: vi.fn(),
    onRunStarted: vi.fn(),
    onOpenCrawlers: vi.fn(),
    ...props,
  };
  renderWithProviders(h(NewContextWizard, { open: true, ...callbacks }), { auth: { authFetch } });
  return callbacks;
}

describe('NewContextWizard (mounted)', () => {
  it('renders nothing when closed', () => {
    const authFetch = routes();
    renderWithProviders(
      h(NewContextWizard, { open: false, onClose: vi.fn() }),
      { auth: { authFetch } },
    );
    expect(screen.queryByText('New context tree')).not.toBeInTheDocument();
  });

  it('shows the three source cards on step 1', async () => {
    renderWizard(routes());
    expect(await screen.findByText('New context tree')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Run a plugin')).toBeInTheDocument();
    expect(screen.getByText('Create manual')).toBeInTheDocument();
  });

  it('opens crawlers and closes when Import is chosen', async () => {
    const cb = renderWizard(routes());
    const user = userEvent.setup();
    await user.click(await screen.findByText('Import'));
    await user.click(screen.getByText('Open Crawlers →'));
    expect(cb.onOpenCrawlers).toHaveBeenCalled();
    expect(cb.onClose).toHaveBeenCalled();
  });

  it('walks the plugin path through configure, preview (dry-run) and run', async () => {
    const authFetch = routes();
    const cb = renderWizard(authFetch);
    const user = userEvent.setup();

    // Step 1 → choose plugin source, Next.
    await user.click(await screen.findByText('Run a plugin'));
    await user.click(screen.getByText('Next ▸'));

    // Step 2 → pick the plugin from the grouped picker.
    await user.click(await screen.findByText('Manager Hierarchy'));
    await user.click(screen.getByText('Next ▸'));

    // Step 3 → schema form. The required string field is seeded from defaults.
    expect(await screen.findByText('Root Name *')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Org Chart')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    await user.click(screen.getByText('Next ▸'));

    // Step 4 → auto dry-run fires and renders the preview. The count line is
    // split across text nodes, so match on the flexible content.
    expect(await screen.findByText(/4 contexts/)).toBeInTheDocument();
    expect(screen.getByText(/12 members/)).toBeInTheDocument();
    expect(screen.getByText(/Engineering/)).toBeInTheDocument();
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('/dry-run'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    // Run the plugin.
    await user.click(screen.getByText('Create tree'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('/run'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(cb.onRunStarted).toHaveBeenCalledWith('run-99'));
    expect(cb.onClose).toHaveBeenCalled();
  });

  it('offers refresh of an existing tree and surfaces a run error', async () => {
    const existingTree = {
      id: 'tree-1',
      sourceAlgorithmName: 'manager-hierarchy',
      sourceInstanceKey: 'inst-abc',
      scopeSystemId: null,
      displayName: 'Existing Org Chart',
      totalMemberCount: 7,
    };
    const authFetch = routes({
      'contexts?variant=generated': { data: [existingTree] },
      '/run': jsonResponse({ error: 'run blew up' }, { ok: false, status: 500 }),
    });
    renderWizard(authFetch);
    const user = userEvent.setup();

    await user.click(await screen.findByText('Run a plugin'));
    await user.click(screen.getByText('Next ▸'));
    await user.click(await screen.findByText('Manager Hierarchy'));
    await user.click(screen.getByText('Next ▸'));
    await user.click(screen.getByText('Next ▸'));

    // Step 4 — pick "Refresh an existing tree" then select the tree.
    expect(await screen.findByText('Refresh an existing tree')).toBeInTheDocument();
    await user.click(screen.getByText('Refresh an existing tree'));
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'inst-abc' } });

    await user.click(await screen.findByText('Refresh tree'));
    expect(await screen.findByText('run blew up')).toBeInTheDocument();
  });

  it('creates a manual context tree', async () => {
    const authFetch = routes({
      '/api/contexts': jsonResponse({ id: 'ctx-new' }, { ok: true, status: 201 }),
    });
    const cb = renderWizard(authFetch);
    const user = userEvent.setup();

    await user.click(await screen.findByText('Create manual'));
    await user.click(screen.getByText('Next ▸'));

    // Step 2 — manual details form.
    expect(await screen.findByText('Target type')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Identity'), { target: { value: 'Resource' } });
    await user.type(screen.getByPlaceholderText('Application'), 'BusinessProcess');
    await user.type(screen.getByPlaceholderText('Procurement app'), 'My Tree');

    await user.click(screen.getByText('Create'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        '/api/contexts',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(cb.onCreated).toHaveBeenCalled());
    expect(cb.onClose).toHaveBeenCalled();
  });

  it('can step back from the plugin picker to the source step', async () => {
    renderWizard(routes());
    const user = userEvent.setup();

    await user.click(await screen.findByText('Run a plugin'));
    await user.click(screen.getByText('Next ▸'));
    await screen.findByText('Manager Hierarchy');
    await user.click(screen.getByText('Back'));
    // Back on step 1 the source cards are shown again.
    expect(await screen.findByText('Run a plugin')).toBeInTheDocument();
  });
});
