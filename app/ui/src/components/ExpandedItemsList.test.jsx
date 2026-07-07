import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ExpandedItemsList from './ExpandedItemsList.jsx';

// The type column is the point of this component after the relationship-graph
// rework: a Direct/Indirect bucket mixes many resourceTypes, so each row must
// say what KIND it is. resourceType (when present) wins over the entity-kind label.
describe('ExpandedItemsList', () => {
  const render = (items) =>
    renderToStaticMarkup(h(ExpandedItemsList, { label: 'Direct', items, loading: false, onOpenDetail: () => {} }));

  it('shows the friendly resourceType as the type column for resource assignments', () => {
    const html = render([
      { key: 'resource:g1', label: 'ABN AMRO', kind: 'item', entityKind: 'resource', entityId: 'g1', resourceType: 'Group' },
      { key: 'resource:o1', label: 'Payroll',  kind: 'item', entityKind: 'resource', entityId: 'o1', resourceType: 'GroupOwnership' },
      { key: 'resource:d1', label: 'Mail.Read', kind: 'item', entityKind: 'resource', entityId: 'd1', resourceType: 'DelegatedPermission' },
    ]);
    expect(html).toContain('ABN AMRO');
    // friendlyLabel splits camelCase, so the type cell reads these, not the raw enum.
    expect(html).toContain('Group Ownership');
    expect(html).toContain('Delegated Permission');
  });

  it('falls back to the entity-kind label when a row has no resourceType (a principal)', () => {
    const html = render([
      { key: 'user:u1', label: 'Alice', kind: 'item', entityKind: 'user', entityId: 'u1' },
    ]);
    expect(html).toContain('Alice');
    expect(html).toContain('User'); // ENTITY_LABELS.user
  });

  it('renders the empty state when there are no items', () => {
    expect(render([])).toContain('Nothing to show');
  });
});
