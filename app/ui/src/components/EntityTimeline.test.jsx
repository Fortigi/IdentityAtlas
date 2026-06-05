import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import EntityTimeline from './EntityTimeline';

// Two changes at the same moment (a sync that changed an attribute and added
// access) → one dot; its detail (selected by default) shows both.
const events = [
  { at: '2026-05-03T10:00:00Z', operation: 'added', eventKind: 'assignment', summary: 'Added to Finance App (Direct)', counterpartyKind: 'resource', counterpartyId: 'res-1', counterpartyLabel: 'Finance App' },
  { at: '2026-05-03T10:00:00Z', operation: 'changed', eventKind: 'attribute', summary: 'Department: Sales → Marketing', attribute: { field: 'department', from: 'Sales', to: 'Marketing' } },
];

describe('EntityTimeline (horizontal)', () => {
  it('shows the selected moment detail: attribute diff + relationship summary', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events, loading: false, sinceDays: 90 }));
    expect(html).toContain('Department'); // attribute field label
    expect(html).toContain('→'); // diff arrow
    expect(html).toContain('Finance App'); // relationship counterparty
    expect(html).toContain('Added'); // op badge
    expect(html).toContain('1 attr · 1 rel'); // dot context label
    expect(html).toContain('2 changes'); // dot shows the change count
    expect(html).not.toContain('indigo'); // interactive colour is blue
  });

  it('shows an empty state when there are no events', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events: [], loading: false, sinceDays: 90 }));
    expect(html).toContain('No changes recorded');
  });

  it('shows a loading state', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events: [], loading: true, sinceDays: 90 }));
    expect(html).toContain('Loading timeline');
  });

  it('marks the active range', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events: [], loading: false, sinceDays: 365 }));
    expect(html).toContain('aria-pressed="true"');
  });
});
