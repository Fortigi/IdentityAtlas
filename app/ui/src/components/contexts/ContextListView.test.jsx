// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextListView from './ContextListView';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const NODES = [
  {
    id: 'ctx-1',
    displayName: 'Engineering Cluster',
    variant: 'generated',
    targetType: 'Identity',
    contextType: 'Cluster',
    directMemberCount: 2,
    totalMemberCount: 5,
    children: [
      { id: 'ctx-2', displayName: 'Backend Squad', variant: 'generated', targetType: 'Identity', contextType: 'Cluster', directMemberCount: 1, totalMemberCount: 1 },
    ],
  },
];

describe('ContextListView', () => {
  it('flattens the tree and renders a row per node', () => {
    renderWithProviders(h(ContextListView, { nodes: NODES, onOpenDetail: () => {} }));

    expect(screen.getByText('Engineering Cluster')).toBeInTheDocument();
    expect(screen.getByText('Backend Squad')).toBeInTheDocument();
    expect(screen.getByText('2 / 2 nodes')).toBeInTheDocument();
  });

  it('wraps the table in a horizontally-scrolling container', () => {
    const { container } = renderWithProviders(h(ContextListView, { nodes: NODES, onOpenDetail: () => {} }));

    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
  });

  it('filters rows by name and opens detail when a row is clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextListView, { nodes: NODES, onOpenDetail }));
    const user = userEvent.setup();

    await user.click(screen.getByText('Engineering Cluster'));
    expect(onOpenDetail).toHaveBeenCalledWith('ctx-1', 'Engineering Cluster');

    await user.type(screen.getByRole('textbox', { name: 'Filter contexts by name' }), 'backend');
    expect(screen.queryByText('Engineering Cluster')).not.toBeInTheDocument();
    expect(screen.getByText('Backend Squad')).toBeInTheDocument();
  });
});
