// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextPicker from './ContextPicker';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, userEvent,
} from '@ui/test-utils/renderWithProviders';

// /api/contexts/tree returns roots with nested children. Two Identity roots
// (one with children) plus a Resource root so the targetType filter has
// something to remove.
function makeTree() {
  return [
    {
      id: 'root-1',
      displayName: 'Org Chart',
      variant: 'generated',
      targetType: 'Identity',
      contextType: 'OrgUnit',
      directMemberCount: 3,
      totalMemberCount: 10,
      children: [
        {
          id: 'child-1',
          displayName: 'Engineering',
          variant: 'generated',
          targetType: 'Identity',
          contextType: 'OrgUnit',
          directMemberCount: 5,
          totalMemberCount: 5,
          children: [],
        },
      ],
    },
    {
      id: 'root-2',
      displayName: 'Manual Group',
      variant: 'manual',
      targetType: 'Identity',
      contextType: 'Tag',
      children: [],
    },
    {
      id: 'root-3',
      displayName: 'Resource Cluster',
      variant: 'synced',
      targetType: 'Resource',
      contextType: 'Cluster',
      children: [],
    },
  ];
}

function routes(body) {
  return makeAuthFetch({ '/api/contexts/tree': body ?? makeTree() });
}

function renderPicker(props = {}, authFetch = routes()) {
  const onPick = props.onPick || vi.fn();
  const onClose = props.onClose || vi.fn();
  const result = renderWithProviders(
    h(ContextPicker, {
      open: props.open ?? true,
      onClose,
      onPick,
      value: props.value,
      targetType: props.targetType,
      title: props.title,
      ...props.extra,
    }),
    { auth: { authFetch } },
  );
  return { ...result, onPick, onClose, authFetch };
}

describe('ContextPicker (mounted)', () => {
  it('renders nothing when closed', () => {
    const { container } = renderPicker({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches and lists the context tree on open', async () => {
    const { authFetch } = renderPicker();
    expect(await screen.findByText('Org Chart')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/tree');
    // Auto-expanded top level reveals the child.
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Manual Group')).toBeInTheDocument();
  });

  it('filters roots by targetType', async () => {
    renderPicker({ targetType: 'Identity' });
    expect(await screen.findByText('Org Chart')).toBeInTheDocument();
    // The Resource-targeted root is filtered out.
    expect(screen.queryByText('Resource Cluster')).not.toBeInTheDocument();
  });

  it('calls onPick then onClose when a node is selected', async () => {
    const { onPick, onClose } = renderPicker();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Org Chart'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-1' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('searches and narrows to matching nodes', async () => {
    renderPicker();
    const user = userEvent.setup();
    await screen.findByText('Org Chart');
    // Reachable by accessible name (aria-label), not just placeholder — #761.
    await user.type(screen.getByRole('textbox', { name: /Search contexts/i }), 'Engineering');
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    // A non-matching sibling root drops out.
    expect(screen.queryByText('Manual Group')).not.toBeInTheDocument();
  });

  it('switches to list view', async () => {
    renderPicker();
    const user = userEvent.setup();
    await screen.findByText('Org Chart');
    await user.click(screen.getByText('List'));
    // Both the root and its child appear flattened in the list.
    expect(screen.getByText('Org Chart')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    const authFetch = makeAuthFetch({
      '/api/contexts/tree': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });
    renderPicker({}, authFetch);
    expect(await screen.findByText(/HTTP 500/i)).toBeInTheDocument();
  });

  it('shows the empty state when no contexts match the targetType', async () => {
    renderPicker({ targetType: 'System' });
    expect(await screen.findByText(/No System-targeted contexts available/i)).toBeInTheDocument();
  });

  it('closes via the Cancel button', async () => {
    const { onClose } = renderPicker();
    const user = userEvent.setup();
    await screen.findByText('Org Chart');
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
