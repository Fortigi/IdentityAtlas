// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import EntityGraph from './EntityGraph';
import {
  renderWithProviders, screen, fireEvent,
} from '@ui/test-utils/renderWithProviders';

// A small radial graph: two root relationship categories, one of which
// carries an expanded child ring (an item leaf) so the fanout layout +
// edge drawing both execute.
function makeNodes() {
  return [
    {
      key: 'groups',
      label: 'Groups',
      count: 12000,
      children: [
        { key: 'groups/g1', label: 'Finance Team', kind: 'item' },
        { key: 'groups/g2', label: 'HR Team', kind: 'item' },
      ],
    },
    { key: 'roles', label: 'Directory Roles', count: 3, recent: 'added' },
    { key: 'apps', label: 'Applications', count: 0, recent: 'removed' },
  ];
}

function renderGraph(props = {}) {
  const onNodeClick = props.onNodeClick || vi.fn();
  const result = renderWithProviders(
    h(EntityGraph, {
      centerLabel: 'USER',
      centerSubLabel: 'Alice Anderson',
      nodes: props.nodes || makeNodes(),
      activeKey: props.activeKey,
      expandedPath: props.expandedPath || ['groups'],
      onNodeClick,
    }),
  );
  return { ...result, onNodeClick };
}

describe('EntityGraph (mounted)', () => {
  it('renders the center node label and sub-label', () => {
    renderGraph();
    expect(screen.getByText('USER')).toBeInTheDocument();
    expect(screen.getByText('Alice Anderson')).toBeInTheDocument();
  });

  it('renders root category labels and a formatted count', () => {
    const { container } = renderGraph();
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getByText('Directory Roles')).toBeInTheDocument();
    // 12000 → "12k" via formatCount.
    expect(screen.getByText('12k')).toBeInTheDocument();
    // An <svg> with edge <line>s is laid out.
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelectorAll('line').length).toBeGreaterThan(0);
  });

  it('renders expanded child item leaves', () => {
    renderGraph();
    expect(screen.getByText('Finance Team')).toBeInTheDocument();
    expect(screen.getByText('HR Team')).toBeInTheDocument();
  });

  it('calls onNodeClick when an active node is clicked', () => {
    const { onNodeClick } = renderGraph();
    // The node label has pointer-events:none; the click handler lives on the
    // wrapping <g>, so click that and let it bubble.
    fireEvent.click(screen.getByText('Groups').closest('g'));
    expect(onNodeClick).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'groups' }),
    );
  });

  it('does not call onNodeClick for an inactive (zero-count) node', () => {
    const { onNodeClick } = renderGraph();
    // "Applications" has count 0 and no item kind → not clickable.
    fireEvent.click(screen.getByText('Applications').closest('g'));
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('shows the pan/zoom hint and a Reset button after zooming', () => {
    const { container } = renderGraph();
    expect(screen.getByText(/drag to pan/i)).toBeInTheDocument();
    // No reset button until the view is dirtied.
    expect(screen.queryByText('Reset view')).not.toBeInTheDocument();
    const svg = container.querySelector('svg');
    fireEvent.wheel(svg, { deltaY: -100 });
    expect(screen.getByText('Reset view')).toBeInTheDocument();
  });

  it('renders an empty graph (just the center) when nodes is empty', () => {
    const { container } = renderGraph({ nodes: [], expandedPath: [] });
    expect(screen.getByText('USER')).toBeInTheDocument();
    // No relationship edges without nodes.
    expect(container.querySelectorAll('line').length).toBe(0);
  });

  it('highlights the active node ring without crashing', () => {
    renderGraph({ activeKey: 'roles' });
    expect(screen.getByText('Directory Roles')).toBeInTheDocument();
  });
});
