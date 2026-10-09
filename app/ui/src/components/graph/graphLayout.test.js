import { describe, it, expect } from 'vitest';
import { layoutGraph, viewBoxOf, radiusOf, NODE_RADIUS } from '@ui/components/graph/graphLayout';

const root = { key: 'r', kind: 'entity', root: true };
const node = (key, origin, kind = 'entity') => ({ key, kind, origin });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('radiusOf', () => {
  it('gives the root, clusters and "more" nodes their own size', () => {
    expect(radiusOf(root)).toBe(NODE_RADIUS.root);
    expect(radiusOf(node('c', 'r', 'cluster'))).toBe(NODE_RADIUS.cluster);
    expect(radiusOf(node('m', 'r', 'more'))).toBe(NODE_RADIUS.more);
    expect(radiusOf(node('e', 'r'))).toBe(NODE_RADIUS.entity);
    expect(radiusOf({ key: 'x', kind: 'odd' })).toBe(NODE_RADIUS.entity);
    expect(new Set(Object.values(NODE_RADIUS)).size).toBe(4);
  });
});

describe('layoutGraph starting positions (no ticks)', () => {
  it('pins the root at the centre, keeps known nodes where they were, spawns new ones beside their origin', () => {
    const pos = layoutGraph(
      [{ ...root }, node('a', 'r'), node('b', 'a'), node('c', 'gone')],
      [],
      { prev: { r: { x: 500, y: 500 }, a: { x: 100, y: -40 } }, ticks: 0 },
    );
    expect(pos.r).toEqual({ x: 0, y: 0 });
    expect(pos.a).toEqual({ x: 100, y: -40 });
    // b is node #2: 70 px from a at 2 × the golden angle.
    const angle = 2 * Math.PI * (3 - Math.sqrt(5));
    expect(pos.b).toEqual({ x: Math.round(100 + 70 * Math.cos(angle)), y: Math.round(-40 + 70 * Math.sin(angle)) });
    // An origin that is not on the canvas spawns around the centre.
    const angle3 = 3 * Math.PI * (3 - Math.sqrt(5));
    expect(pos.c).toEqual({ x: Math.round(70 * Math.cos(angle3)), y: Math.round(70 * Math.sin(angle3)) });
  });
});

describe('layoutGraph settled', () => {
  const nodes = [root, node('a', 'r'), node('b', 'r'), node('c', 'r'), node('d', 'a'), node('e', 'a')];
  const edges = [['r', 'a'], ['r', 'b'], ['r', 'c'], ['a', 'd'], ['a', 'e'], ['b', 'c']].map(([from, to]) => ({ from, to }));

  it('keeps the root at the centre and no two nodes overlapping', () => {
    const pos = layoutGraph(nodes, edges);
    expect(pos.r).toEqual({ x: 0, y: 0 });
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.key < b.key) expect(dist(pos[a.key], pos[b.key])).toBeGreaterThan(radiusOf(a) + radiusOf(b));
      }
    }
  });

  it('is deterministic', () => {
    expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
  });

  it('pulls linked nodes closer than unlinked ones', () => {
    const pos = layoutGraph(nodes, edges);
    // d hangs off a, not off the root.
    expect(dist(pos.d, pos.a)).toBeLessThan(dist(pos.d, pos.r));
  });

  it('leaves a pinned node exactly where it was dropped', () => {
    const pos = layoutGraph(nodes, edges, { pinned: { d: { x: 400, y: -300 } } });
    expect(pos.d).toEqual({ x: 400, y: -300 });
  });

  it('the root cannot be pinned elsewhere', () => {
    expect(layoutGraph(nodes, edges, { pinned: { r: { x: 50, y: 50 } } }).r).toEqual({ x: 0, y: 0 });
  });

  it('moves already-settled nodes only a little when a node joins', () => {
    const first = layoutGraph(nodes, edges);
    const grown = layoutGraph([...nodes, node('f', 'e')], [...edges, { from: 'e', to: 'f' }], { prev: first });
    for (const n of nodes) expect(dist(first[n.key], grown[n.key])).toBeLessThan(80);
  });
});

describe('viewBoxOf', () => {
  it('is the default canvas around the centre when empty or small', () => {
    expect(viewBoxOf({})).toEqual({ x: -260, y: -200, width: 520, height: 400 });
    expect(viewBoxOf({ r: { x: 0, y: 0 }, a: { x: 100, y: 50 } })).toEqual({ x: -210, y: -175, width: 520, height: 400 });
  });

  it('grows to hold every node plus room for its label', () => {
    expect(viewBoxOf({ a: { x: -400, y: -10 }, b: { x: 400, y: 600 } }))
      .toEqual({ x: -470, y: -80, width: 940, height: 750 });
  });
});
