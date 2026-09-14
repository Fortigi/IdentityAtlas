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
// identity's names cell spans one column per account, and an accounts row below
// fills that span. The identity has no column of its own while expanded —
// collapsing it is what brings its combined column back.
describe('MatrixColumnHeaders accounts row', () => {
  // An identity with two linked accounts, exactly as columnModel.buildColumns
  // emits them: the accounts stand in for their parent, carry it on `parent` and
  // inherit its sort keys.
  const alice = { id: 'id1', displayName: 'Alice', memberType: 'Identity', accountCount: 2, sortKeys: ['Finance', 'Payroll', 'Analyst'] };
  const expandedUsers = [
    { id: 'acc1', displayName: 'Alice', isAccountCol: true, parentId: 'id1', parent: alice, accountType: 'AAD', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
    { id: 'acc2', displayName: 'A.Jansen', isAccountCol: true, parentId: 'id1', parent: alice, accountType: 'SAP', sortKeys: ['Finance', 'Payroll', 'Analyst'] },
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
    expect(identityCell.colSpan).toBe(2); // one column per account, nothing else

    // The accounts row carries both account labels and no roll-up cell…
    expect(accountsRow).not.toHaveTextContent('All accounts');
    expect(screen.getByText('Alice · AAD').closest('tr')).toBe(accountsRow);
    expect(screen.getByText('A.Jansen · SAP').closest('tr')).toBe(accountsRow);
    // …and a subject that is not expanded stays on the names row, spanning both.
    const carol = screen.getByText('Carol').closest('th');
    expect(carol.closest('tr')).toBe(namesRow);
    expect(carol.rowSpan).toBe(2);
  });

  it('keeps the account count on the identity while it is expanded', () => {
    // The count may stay up once expanded — it still describes the span below.
    const { container } = renderExpanded();
    const identityCell = screen.getByText('Alice').closest('th');
    expect(identityCell).toHaveTextContent('2');
    // The accounts themselves never carry one: an account expands into nothing.
    const accountsRow = [...container.querySelectorAll('thead tr')].at(-1);
    expect(accountsRow).not.toHaveTextContent('2');
  });
});

// ─── Linked-account count on an identity header (#1212 follow-up) ─────────────
//
// The count says how many accounts the column expands into, and it has to be
// readable BEFORE expanding — that is how the analyst picks which identities are
// worth a click. It rides along on the matrix rows, so no fetch is involved.
describe('MatrixColumnHeaders identity account count', () => {
  const subjects = [
    { id: 'id1', displayName: 'Alice', memberType: 'Identity', accountCount: 3, sortKeys: ['Finance'] },
    { id: 'id2', displayName: 'Bob', memberType: 'Identity', accountCount: 0, sortKeys: ['Finance'] },
    { id: 'u3', displayName: 'Carol', memberType: 'User', accountCount: 7, sortKeys: ['Ops'] },
  ];
  const renderSubjects = () => renderHeaders([{ attribute: 'department' }], {
    users: subjects,
    expandedIdentities: new Set(),
    loadingIdentityCols: new Set(),
  });

  it('badges an unexpanded identity with its number of linked accounts', () => {
    renderSubjects();
    const alice = screen.getByText('Alice').closest('th');
    expect(alice).toHaveTextContent('3');
    // The bare number needs the tooltip to say what it counts.
    expect(alice.getAttribute('title')).toContain('3 linked accounts');
    // Nothing was fetched to learn it — the count came in with the grid rows,
    // and the identity is still collapsed.
    expect(alice.querySelector('[title="Expand into linked accounts"]')).toBeTruthy();
  });

  it('leaves it off an identity with no linked accounts', () => {
    renderSubjects();
    const bob = screen.getByText('Bob').closest('th');
    expect(bob).toHaveTextContent('Bob');
    expect(bob.textContent.replace('Bob', '')).not.toMatch(/\d/);
    expect(bob.getAttribute('title')).not.toContain('linked account');
  });

  it('leaves it off a plain account subject', () => {
    // A principal-row matrix has no identities: every subject IS an account, so
    // a count would be meaningless even if a stray value rode along.
    renderSubjects();
    const carol = screen.getByText('Carol').closest('th');
    expect(carol.textContent.replace('Carol', '')).not.toMatch(/\d/);
    expect(carol.getAttribute('title')).not.toContain('linked account');
  });
});
