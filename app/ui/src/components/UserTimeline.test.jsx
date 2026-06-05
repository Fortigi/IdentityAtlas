import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import UserTimeline from './UserTimeline';

const events = [
  { at: '2026-05-03T10:00:00Z', operation: 'added', eventKind: 'assignment', summary: 'Added to Finance App (Direct)', counterpartyKind: 'resource', counterpartyId: 'res-1', counterpartyLabel: 'Finance App' },
  { at: '2026-05-02T10:00:00Z', operation: 'changed', eventKind: 'attribute', summary: 'Department: Sales → Marketing', attribute: { field: 'department', from: 'Sales', to: 'Marketing' } },
];

describe('UserTimeline', () => {
  it('renders attribute diffs and relationship summaries', () => {
    const html = renderToStaticMarkup(h(UserTimeline, { events, loading: false, sinceDays: 90 }));
    expect(html).toContain('Department'); // attribute field label
    expect(html).toContain('→'); // diff arrow
    expect(html).toContain('Finance App'); // relationship counterparty
    expect(html).toContain('Added'); // op badge
    expect(html).not.toContain('indigo'); // interactive colour is blue, not legacy indigo
  });

  it('shows an empty state when there are no events', () => {
    const html = renderToStaticMarkup(h(UserTimeline, { events: [], loading: false, sinceDays: 90 }));
    expect(html).toContain('No changes recorded');
  });

  it('shows a loading state', () => {
    const html = renderToStaticMarkup(h(UserTimeline, { events: [], loading: true, sinceDays: 90 }));
    expect(html).toContain('Loading timeline');
  });

  it('marks the active range', () => {
    const html = renderToStaticMarkup(h(UserTimeline, { events: [], loading: false, sinceDays: 365 }));
    expect(html).toContain('aria-pressed="true"');
  });
});
