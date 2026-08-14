// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixColumnHeaders, { GROUP_ROW_H } from './MatrixColumnHeaders';
import { VALUE_ROW_H } from './headerMode';
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

function renderHeaders(sortAttributes, props = {}) {
  return renderWithProviders(
    h('table', null,
      h(MatrixColumnHeaders, {
        users: makeUsers(),
        infoColumnCount: 3,
        sortAttributes,
        ...props,
      })),
  );
}

describe('MatrixColumnHeaders sticky header', () => {
  it('pins the whole <thead> with a negative top so grouping rows scroll away without leaving a grey gap', () => {
    const attrs = [{ attribute: 'businessUnit' }, { attribute: 'division' }, { attribute: 'department' }];
    const { container } = renderHeaders(attrs, { headerMode: 'rotated' });

    const thead = container.querySelector('thead');
    expect(thead).toBeTruthy();
    // The whole section is sticky — not just the last row's cells — so the
    // header can never escape its section box and leave a blank band.
    expect(thead.className).toContain('sticky');
    // Negative offset equals the combined grouping-row height; the names row
    // therefore comes to rest at top:0 and stays pinned through the body.
    expect(thead.style.top).toBe(`-${attrs.length * GROUP_ROW_H}px`);
  });

  it('scales the rotated offset with the number of grouping rows', () => {
    const one = renderHeaders([{ attribute: 'department' }], { headerMode: 'rotated' });
    expect(one.container.querySelector('thead').style.top).toBe(`-${GROUP_ROW_H}px`);

    const two = renderHeaders([{ attribute: 'businessUnit' }, { attribute: 'department' }], { headerMode: 'rotated' });
    expect(two.container.querySelector('thead').style.top).toBe(`-${2 * GROUP_ROW_H}px`);
  });

  it('offsets by the real cross-table height when the compact header is used (AC1)', () => {
    // Two departments and two teams → 4 value rows of 20px, not 2 × 120px.
    const attrs = [{ attribute: 'businessUnit' }, { attribute: 'department' }];
    const { container } = renderHeaders(attrs, { headerMode: 'cross' });
    expect(container.querySelector('thead').style.top).toBe(`-${4 * VALUE_ROW_H}px`);
  });

  it('renders no grouping rows — and no offset — for an empty matrix (AC7)', () => {
    const { container } = renderWithProviders(
      h('table', null, h(MatrixColumnHeaders, { users: [], infoColumnCount: 3, sortAttributes: [{ attribute: 'department' }] })),
    );
    expect(container.querySelector('thead').style.top).toBe('0px'); // jsdom normalises -0px
    expect(container.querySelectorAll('thead tr')).toHaveLength(1); // names row only
  });

  it('picks the mode itself when the caller does not pin one', () => {
    // 3 subjects / 3 distinct values per level → the cross table is shorter.
    const { container } = renderHeaders([{ attribute: 'department' }]);
    expect(container.querySelector('thead').style.top).toBe(`-${2 * VALUE_ROW_H}px`);
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

  it.each(['rotated', 'cross'])('keeps every %s header row the same width as a resource row', (headerMode) => {
    const users = makeUsers();
    const { container } = renderHeaders(
      [{ attribute: 'businessUnit' }, { attribute: 'department' }],
      { headerMode, accessPackages: [{ id: 'ap1', displayName: 'AP One' }] },
    );
    const rows = [...container.querySelectorAll('thead tr')];

    // A resource row emits: drag handle + name + contexts + one cell per subject
    // + one per access package + the three right-side metadata cells. Each
    // grouping row spans the three info columns with a single colSpan cell, so
    // the widths must still match.
    const widthOf = (tr) => [...tr.children]
      .reduce((n, th) => n + (Number(th.getAttribute('colspan')) || 1), 0);
    const expected = 3 + users.length + 1 + 3;
    for (const tr of rows) expect(widthOf(tr)).toBe(expected);
  });
});
