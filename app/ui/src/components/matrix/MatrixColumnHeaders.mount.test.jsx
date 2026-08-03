// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixColumnHeaders, { GROUP_ROW_H } from './MatrixColumnHeaders';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

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

describe('MatrixColumnHeaders right-side metadata columns', () => {
  it('labels the Contexts column on the pinned names row', () => {
    const { container } = renderHeaders([{ attribute: 'department' }]);
    const headerRow = container.querySelectorAll('thead tr')[1];
    const labels = [...headerRow.querySelectorAll('th')].map(th => th.textContent.trim());
    // Contexts sits between the member count and the description.
    expect(labels.slice(-3)).toEqual(['# \u25BC', 'Contexts', 'Description']);
  });

  it('adds a matching placeholder cell on every attribute grouping row so the columns stay aligned', () => {
    const attrs = [{ attribute: 'businessUnit' }, { attribute: 'department' }];
    const { container } = renderHeaders(attrs);
    const rows = [...container.querySelectorAll('thead tr')];
    // Each grouping row ends with the same three metadata cells as the names
    // row (#, Contexts, Description) — otherwise the columns shear.
    for (const row of rows.slice(0, attrs.length)) {
      const trailing = [...row.querySelectorAll('th')].slice(-3);
      expect(trailing).toHaveLength(3);
      expect(trailing.every(th => th.textContent === '')).toBe(true);
    }
  });
});

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
