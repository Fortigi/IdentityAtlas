// @vitest-environment jsdom
//
// The relationship graph end to end: useRelationGraph + RelationGraphPanel +
// RelationGraph against stubbed endpoints. The case that motivated it: a group
// whose name matches a customer in an organisation list. The customer is ONE
// edge "name" away, and expanding the customer brings the group back as an edge
// to the node already there, not as a second group node.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within } from '@ui/test-utils/renderWithProviders';
import useRelationGraph from '@ui/hooks/useRelationGraph';
import RelationGraphPanel from './RelationGraphPanel';

const GROUP = { attributes: { displayName: 'GRP-Northwind', resourceType: 'Group' }, assignmentByType: { Direct: 12 }, contextCount: 1 };
const LINKED = {
  total: 1,
  groups: [{ key: 'direct|Klant|displayName', entityType: 'Klant', via: 'displayName', kind: 'direct', label: 'Klant · name', count: 1,
    items: [{ entityId: 'k1', entityType: 'Klant', label: 'Northwind' }] }],
};
const KLANT_GRAPH = {
  core: { id: 'k1', entityType: 'Klant', displayName: 'Northwind' },
  categories: [
    { key: 'link:Resource', label: 'Resources', count: 1 },
    { key: 'rel:out:eigenaar', label: 'eigenaar →', count: 1 },
  ],
};
const members = Array.from({ length: 12 }, (_, i) => ({ principalId: `u${i}`, principalDisplayName: `Member ${String(i).padStart(2, '0')}`, assignmentType: 'Direct' }));

function routes(extra = {}) {
  return makeAuthFetch({
    '/api/resources/g1/assignments': members,
    '/api/resources/g1/contexts': [{ id: 'c1', displayName: 'Sales' }],
    '/api/org-truth/linked/Resource/g1': LINKED,
    '/api/org-truth/linked/Context/c1': { total: 0, groups: [] },
    '/api/contexts/c1': { members: [], subContexts: [] },
    'k1/graph?category=link%3AResource': { items: [{ key: 'resource:g1', label: 'GRP-Northwind', entityKind: 'resource', entityId: 'g1', resourceType: 'Group' }] },
    'k1/graph?category=rel%3Aout%3Aeigenaar': { items: [{ key: 'org-entity:p1', label: 'Dana Contoso', entityKind: 'org-entity', entityId: 'p1', entityType: 'Person' }] },
    '/api/org-truth/entities/k1/graph': KLANT_GRAPH,
    ...extra,
  });
}

// Stable, like the memoised extras of a detail page: a new object per render
// would restart the graph every render.
const EXTRAS = {};

function Harness({ authFetch, onOpenDetail }) {
  const graph = useRelationGraph({
    root: { kind: 'resource', id: 'g1', label: 'GRP-Northwind', typeLabel: 'Group' },
    rootCore: GROUP,
    rootExtras: EXTRAS,
    authFetch,
  });
  return <RelationGraphPanel graph={graph} onOpenDetail={onOpenDetail} />;
}

function render({ orgTruth = true, authFetch = routes() } = {}) {
  const onOpenDetail = vi.fn();
  const utils = renderWithProviders(<Harness authFetch={authFetch} onOpenDetail={onOpenDetail} />, { features: { orgTruth } });
  return { ...utils, authFetch, onOpenDetail };
}

const nodeKeys = (c) => [...c.querySelectorAll('[data-node]')].map(n => n.getAttribute('data-node')).sort();
const edges = (c) => [...c.querySelectorAll('[data-edge]')].map(e => `${e.getAttribute('data-edge')} ${e.textContent}`).sort();

describe('RelationGraph', () => {
  it('draws the customer as a direct neighbour of the group, one edge "name", no Organisation bucket', async () => {
    const { container } = render();
    await screen.findByRole('button', { name: 'Klant Northwind, press to expand' });
    expect(nodeKeys(container)).toEqual(['cluster:resource:g1:members-direct', 'context:c1', 'org-entity:k1', 'resource:g1']);
    expect(edges(container)).toEqual([
      'cluster:resource:g1:members-direct->resource:g1 member of',
      'resource:g1->context:c1 in context',
      'resource:g1->org-entity:k1 name',
    ]);
    expect(screen.queryByText('Organisation')).toBeNull();
    expect(screen.queryByText(/Klant · name/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Group GRP-Northwind, expanded, press to collapse' })).toBeInTheDocument();
  });

  it('expanding the customer brings the group back as an edge to the same node, not a second node', async () => {
    const { container } = render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Klant Northwind, press to expand' }));
    await screen.findByRole('button', { name: 'Person Dana Contoso, press to expand' });
    expect(nodeKeys(container)).toEqual([
      'cluster:resource:g1:members-direct', 'context:c1', 'org-entity:k1', 'org-entity:p1', 'resource:g1',
    ]);
    expect(container.querySelectorAll('[data-node="resource:g1"]')).toHaveLength(1);
    expect(edges(container)).toEqual([
      'cluster:resource:g1:members-direct->resource:g1 member of',
      'org-entity:k1->org-entity:p1 eigenaar',
      'resource:g1->context:c1 in context',
      'resource:g1->org-entity:k1 name',
    ]);

    // Collapsing the customer removes only what it alone brought in.
    await user.click(screen.getByRole('button', { name: 'Klant Northwind, expanded, press to collapse' }));
    expect(nodeKeys(container)).toEqual(['cluster:resource:g1:members-direct', 'context:c1', 'org-entity:k1', 'resource:g1']);
  });

  it('opens a cluster into its objects and lists all of them below', async () => {
    const { container } = render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '12 Direct Members, press to show them' }));
    expect(await screen.findByRole('heading', { name: 'GRP-Northwind → Direct Members' })).toBeInTheDocument();
    expect(nodeKeys(container).filter(k => k.startsWith('user:'))).toHaveLength(12);
    expect(container.querySelector('[data-node^="cluster:"]')).toBeNull();
    expect(within(container.querySelector('table')).getAllByRole('button').map(b => b.textContent)).toHaveLength(12);
  });

  it('opens the detail page from a name, by click, Enter or double click — never for the page itself', async () => {
    const { onOpenDetail } = render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Open Northwind' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('org-entity', 'k1', 'Northwind');
    screen.getByRole('link', { name: 'Open Sales' }).focus();
    await user.keyboard('{Enter}');
    expect(onOpenDetail).toHaveBeenLastCalledWith('context', 'c1', 'Sales');
    await user.dblClick(screen.getByRole('button', { name: 'Klant Northwind, press to expand' }));
    expect(onOpenDetail).toHaveBeenLastCalledWith('org-entity', 'k1', 'Northwind');
    expect(screen.queryByRole('link', { name: 'Open GRP-Northwind' })).toBeNull();
  });

  it('expands from the keyboard and collapses everything back to the root', async () => {
    const { container } = render();
    const user = userEvent.setup();
    (await screen.findByRole('button', { name: 'Context Sales, press to expand' })).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Context Sales, expanded, press to collapse' });
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    await screen.findByRole('button', { name: 'Context Sales, press to expand' });
    expect(nodeKeys(container)).toHaveLength(4);
  });

  it('leaves the organisation lists alone when the feature is off', async () => {
    const { authFetch, container } = render({ orgTruth: false });
    await screen.findByRole('button', { name: 'Context Sales, press to expand' });
    expect(nodeKeys(container)).not.toContain('org-entity:k1');
    expect(authFetch.mock.calls.some(c => c[0].includes('/org-truth/'))).toBe(false);
  });

  it('a 404 from the organisation lists just means no organisation neighbours', async () => {
    const { container } = render({ authFetch: routes({ '/api/org-truth/linked/Resource/g1': jsonResponse({}, { ok: false, status: 404 }) }) });
    await screen.findByRole('button', { name: 'Context Sales, press to expand' });
    expect(nodeKeys(container)).toEqual(['cluster:resource:g1:members-direct', 'context:c1', 'resource:g1']);
  });

  it('drags a node to a new place without expanding it, and pans and zooms the canvas', async () => {
    const { container } = render();
    const node = await screen.findByRole('button', { name: 'Klant Northwind, press to expand' });
    const holder = container.querySelector('[data-node="org-entity:k1"]');
    const before = holder.style.transform;
    const svg = screen.getByRole('group', { name: 'Relationship graph' });
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 90 });
    fireEvent.pointerUp(svg);
    fireEvent.click(node);
    const after = container.querySelector('[data-node="org-entity:k1"]').style.transform;
    expect(after).not.toBe(before);
    expect(screen.getByRole('button', { name: 'Klant Northwind, press to expand' })).toBeInTheDocument();

    // A small twitch is still a click.
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(svg, { clientX: 11, clientY: 11 });
    fireEvent.pointerUp(svg);
    fireEvent.click(node);
    await screen.findByRole('button', { name: 'Klant Northwind, expanded, press to collapse' });

    // Canvas drag pans; the wheel zooms; Reset view undoes both.
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: 0 });
    fireEvent.pointerUp(svg);
    fireEvent.wheel(svg, { deltaY: -100 });
    expect(screen.getByText(/· 110%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull();
    expect(screen.queryByText(/· 110%/)).toBeNull();
  });

  it('a right-click does not start a pan', async () => {
    render();
    const svg = await screen.findByRole('group', { name: 'Relationship graph' });
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, button: 2, pointerType: 'mouse' });
    fireEvent.pointerMove(svg, { clientX: 80, clientY: 0 });
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull();
  });

  it('says where to start until a cluster fills the list', async () => {
    render();
    expect(await screen.findByText(/click a numbered cluster to list all of its objects here/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
  });
});
