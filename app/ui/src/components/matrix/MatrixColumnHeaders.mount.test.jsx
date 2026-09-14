// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixColumnHeaders, { GROUP_ROW_H } from './MatrixColumnHeaders';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

// Build subjects whose sortKeys line up with `sortAttributes`, so the header
// renders one grouping row per attribute.
function makeUsers() {
  return [
    { id: 'u1', displayName: 'Alice', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
    { id: 'u2', displayName: 'Bob', sortKeys: ['Finance', 'Payroll', 'Manager'] },
    { id: 'u3', displayName: 'Carol', sortKeys: ['Ops', 'Logistics', 'Planner'] },
  ];
}

function renderHeaders(sortAttributes, overrides = {}) {
  return renderWithProviders(
    h('table', null,
      h(MatrixColumnHeaders, {
        users: makeUsers(),
        infoColumnCount: 3,
        sortAttributes,
        ...overrides,
      })),
  );
}

describe('MatrixColumnHeaders sticky header', () => {
  it('pins the whole <thead> with a negative top so grouping rows scroll away without leaving a grey gap', () => {
    const attrs = [{ attribute: 'businessUnit' }, { attribute: 'division' }, { attribute: 'department' }];
    const { container } = renderHeaders(attrs);

    const thead = container.querySelector('thead');
    expect(thead).toBeTruthy();
    // The whole section is sticky — not just the last row's cells — so the
    // header can never escape its section box and leave a blank band.
    expect(thead.className).toContain('sticky');
    // Negative offset equals the combined grouping-row height; the names row
    // therefore comes to rest at top:0 and stays pinned through the body.
    expect(thead.style.top).toBe(`-${attrs.length * GROUP_ROW_H}px`);
  });

  it('scales the offset with the number of grouping rows', () => {
    const one = renderHeaders([{ attribute: 'department' }]);
    expect(one.container.querySelector('thead').style.top).toBe(`-${GROUP_ROW_H}px`);

    const two = renderHeaders([{ attribute: 'businessUnit' }, { attribute: 'department' }]);
    expect(two.container.querySelector('thead').style.top).toBe(`-${2 * GROUP_ROW_H}px`);
  });
});

describe('MatrixColumnHeaders metadata columns', () => {
  it('pins Contexts beside the resource name and labels Type on the right', () => {
    const { container } = renderHeaders([{ attribute: 'department' }]);
    const namesRow = [...container.querySelectorAll('thead tr')].at(-1);
    const headers = [...namesRow.children];

    // Info block: drag handle | Resource Name | Contexts — all sticky-left.
    expect(headers[1]).toHaveTextContent('Resource Name');
    expect(headers[2]).toHaveTextContent('Contexts');
    expect(headers[2].style.left).toBe('299px');
    expect(headers[2].className).toContain('sticky');

    // Right-side metadata block: # | Type | Description.
    expect(headers.at(-2)).toHaveTextContent('Type');
    expect(headers.at(-1)).toHaveTextContent('Description');
    expect(screen.getByText('Contexts')).toBeInTheDocument();
  });

  it('keeps every header row the same width as a resource row (# | Type | Description)', () => {
    const users = makeUsers();
    const { container } = renderHeaders([{ attribute: 'businessUnit' }, { attribute: 'department' }]);
    const rows = [...container.querySelectorAll('thead tr')];

    // A resource row emits: drag handle + name + contexts + one cell per subject
    // + the three right-side metadata cells. Each grouping row spans the three
    // info columns with a single colSpan cell, so the widths must still match.
    const widthOf = (tr) => [...tr.children]
      .reduce((n, th) => n + (Number(th.getAttribute('colspan')) || 1), 0);
    const expected = 3 + users.length + 3;
    for (const tr of rows) expect(widthOf(tr)).toBe(expected);
  });
});

// ─── Expanding an identity into its accounts (#1212) ──────────────────────────
//
// The accounts of an expanded identity belong UNDER it, not beside it: the
// identity's names cell spans its own roll-up column plus one column per
// account, and an accounts row below fills that span.
describe('MatrixColumnHeaders accounts row', () => {
  // An identity with two linked accounts, exactly as columnModel.buildColumns
  // emits them: the accounts follow their parent and inherit its sort keys.
  const expandedUsers = [
    { id: 'id1', displayName: 'Alice', memberType: 'Identity', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
    { id: 'acc1', displayName: 'Alice', isAccountCol: true, parentId: 'id1', accountType: 'AAD', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
    { id: 'acc2', displayName: 'A.Jansen', isAccountCol: true, parentId: 'id1', accountType: 'SAP', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
    { id: 'u3', displayName: 'Carol', sortKeys: ['Ops', 'Logistics', 'Planner'] },
  ];

  const renderExpanded = () => renderHeaders([{ attribute: 'department' }], {
    users: expandedUsers,
    expandedIdentities: new Set(['id1']),
    loadingIdentityCols: new Set(),
  });

  it('adds the accounts row only while an identity is expanded', () => {
    const plain = renderHeaders([{ attribute: 'department' }]);
    expect(plain.container.querySelectorAll('thead tr')).toHaveLength(2); // grouping + names

    const expanded = renderExpanded();
    expect(expanded.container.querySelectorAll('thead tr')).toHaveLength(3);
  });

  it('keeps the sticky offset on the grouping rows alone, so the pinned header leaves no grey band', () => {
    // The accounts row sits AFTER the names row, so it pins with it. Counting it
    // into the negative `top` would push the header out of view on scroll.
    const { container } = renderExpanded();
    expect(container.querySelector('thead').style.top).toBe(`-${GROUP_ROW_H}px`);
  });

  it('keeps every header row exactly as wide as a resource row', () => {
    // Walk the header as a grid: a cell occupies `colspan` columns on each of
    // the `rowspan` rows it covers. If the spans didn't add up, every body cell
    // beside an expanded identity would shift one column.
    const { container } = renderExpanded();
    const rows = [...container.querySelectorAll('thead tr')];
    const width = new Array(rows.length).fill(0);
    rows.forEach((tr, r) => {
      for (const th of tr.children) {
        const cols = Number(th.getAttribute('colspan')) || 1;
        const span = Number(th.getAttribute('rowspan')) || 1;
        for (let i = 0; i < span; i++) width[r + i] += cols;
      }
    });
    const expected = 3 + expandedUsers.length + 3;
    expect(width).toEqual(new Array(rows.length).fill(expected));
  });

  it('spans the identity over its accounts and puts their labels in the row below', () => {
    const { container } = renderExpanded();
    const [, namesRow, accountsRow] = [...container.querySelectorAll('thead tr')];

    // 'Alice' exactly — the account below her is labelled 'Alice · AAD'.
    const identityCell = screen.getByText('Alice').closest('th');
    expect(identityCell.closest('tr')).toBe(namesRow);
    expect(identityCell.colSpan).toBe(3); // roll-up column + two accounts

    // The accounts row carries the roll-up label and both account labels…
    expect(accountsRow).toHaveTextContent('All accounts');
    expect(screen.getByText('Alice · AAD').closest('tr')).toBe(accountsRow);
    expect(screen.getByText('A.Jansen · SAP').closest('tr')).toBe(accountsRow);
    // …and a subject that is not expanded stays on the names row, spanning both.
    const carol = screen.getByText('Carol').closest('th');
    expect(carol.closest('tr')).toBe(namesRow);
    expect(carol.rowSpan).toBe(2);
  });
});
