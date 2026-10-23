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

  it('renders access-review events', () => {
    const reviewEvents = [
      { at: '2026-06-04T10:00:00Z', operation: 'added', eventKind: 'review', summary: 'Access review started' },
    ];
    const html = renderToStaticMarkup(h(EntityTimeline, { events: reviewEvents, loading: false, sinceDays: 90 }));
    expect(html).toContain('Access review started');
    expect(html).toContain('1 rel'); // a review counts as a relationship-kind event
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

describe('EntityTimeline — hidden fields and readable dates', () => {
  const stamp = { at: '2026-10-20T12:06:02Z', operation: 'changed', eventKind: 'attribute', summary: 's', attribute: { field: 'lastCalculatedAt', from: '—', to: '2026-10-20T12:06:02.810942+00:00' } };
  const rename = { at: '2026-10-19T09:00:00Z', operation: 'changed', eventKind: 'attribute', summary: 's', attribute: { field: 'displayName', from: 'Eng', to: 'Engineering' } };

  it('skips the attribute events a page hides, keeping the rest', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events: [stamp, rename], loading: false, sinceDays: 90, hideFields: ['lastCalculatedAt'] }));
    expect(html).not.toContain('Last Calculated At');
    expect(html).toContain('Engineering');
    // Only the rename's day is left on the line.
    expect(html.match(/aria-pressed="(true|false)"/g).length).toBe(4 + 1);
  });

  it('shows everything when nothing is hidden, with an ISO value as a readable date', () => {
    const html = renderToStaticMarkup(h(EntityTimeline, { events: [stamp], loading: false, sinceDays: 90 }));
    expect(html).toContain('Last Calculated At');
    expect(html).not.toContain('2026-10-20T12:06:02.810942');
    expect(html).toContain('2026');
  });
});
