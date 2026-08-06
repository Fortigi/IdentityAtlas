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

function renderHeaders(sortAttributes) {
  return renderWithProviders(
    h('table', null,
      h(MatrixColumnHeaders, {
        users: makeUsers(),
        infoColumnCount: 3,
        sortAttributes,
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
