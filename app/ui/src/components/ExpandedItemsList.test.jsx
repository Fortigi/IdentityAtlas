import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ExpandedItemsList from './ExpandedItemsList.jsx';
import { rowType, sortItems, itemsToCsv } from './ExpandedItemsList.helpers.js';

const ITEMS = [
  { key: 'resource:g1', label: 'ABN AMRO', kind: 'item', entityKind: 'resource', entityId: 'g1', resourceType: 'Group' },
  { key: 'resource:o1', label: 'Payroll',  kind: 'item', entityKind: 'resource', entityId: 'o1', resourceType: 'GroupOwnership' },
  { key: 'resource:d1', label: 'Mail.Read', kind: 'item', entityKind: 'resource', entityId: 'd1', resourceType: 'DelegatedPermission' },
];

// rowType is the whole point of the type column after the graph rework: a
// Direct/Indirect bucket mixes many resourceTypes, so each row must say what
// KIND it is. resourceType (when present) wins over the entity-kind label.
describe('rowType', () => {
  it('prefers the friendly resourceType', () => {
    expect(rowType({ entityKind: 'resource', resourceType: 'GroupOwnership' })).toBe('Group Ownership');
    expect(rowType({ entityKind: 'resource', resourceType: 'DelegatedPermission' })).toBe('Delegated Permission');
  });
  it('falls back to the entity-kind label when there is no resourceType (a principal)', () => {
    expect(rowType({ entityKind: 'user' })).toBe('User');
  });
});

describe('sortItems', () => {
  it('sorts by name asc/desc, case-insensitively', () => {
    expect(sortItems(ITEMS, 'name', 'asc').map((i) => i.label)).toEqual(['ABN AMRO', 'Mail.Read', 'Payroll']);
    expect(sortItems(ITEMS, 'name', 'desc').map((i) => i.label)).toEqual(['Payroll', 'Mail.Read', 'ABN AMRO']);
  });
  it('sorts by type (friendly resourceType)', () => {
    // Delegated Permission < Group < Group Ownership
    expect(sortItems(ITEMS, 'type', 'asc').map((i) => i.resourceType)).toEqual(['DelegatedPermission', 'Group', 'GroupOwnership']);
  });
  it('does not mutate the input', () => {
    const copy = [...ITEMS];
    sortItems(ITEMS, 'name', 'desc');
    expect(ITEMS).toEqual(copy);
  });
});

describe('itemsToCsv', () => {
  it('emits a header + one row per item with Name,Type,Via', () => {
    const csv = itemsToCsv([{ label: 'ABN AMRO', entityKind: 'resource', resourceType: 'Group', via: 'acct@x' }]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Name,Type,Via');
    expect(lines[1]).toBe('"ABN AMRO","Group","acct@x"');
  });
  it('escapes embedded quotes and commas per RFC-4180', () => {
    const csv = itemsToCsv([{ label: 'A, "B"', entityKind: 'resource', resourceType: 'Group' }]);
    expect(csv.split('\r\n')[1]).toBe('"A, ""B""","Group",""');
  });
});

describe('ExpandedItemsList render', () => {
  const render = (items) =>
    renderToStaticMarkup(h(ExpandedItemsList, { label: 'Direct', items, loading: false, onOpenDetail: () => {} }));

  it('renders the friendly resourceType as the type column, plus sort headers and an export control', () => {
    const html = render(ITEMS);
    expect(html).toContain('ABN AMRO');
    expect(html).toContain('Group Ownership');
    expect(html).toContain('Delegated Permission');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Name');
    expect(html).toContain('Type');
  });

  it('renders the empty state when there are no items', () => {
    expect(render([])).toContain('Nothing to show');
  });

  it('scroll container carries both overflow-y-auto and overflow-x-auto (#758)', () => {
    const html = render(ITEMS);
    // The scroll container is the single class-bearing div wrapping the table's
    // sticky header — assert both axes are present on it, not just anywhere in the page.
    expect(html).toMatch(/class="[^"]*overflow-y-auto[^"]*overflow-x-auto[^"]*"/);
  });
});
