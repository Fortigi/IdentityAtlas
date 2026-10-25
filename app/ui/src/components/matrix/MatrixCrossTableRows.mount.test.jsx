// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import MatrixColumnHeaders from './MatrixColumnHeaders';
import { VALUE_ROW_H } from './headerMode';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

// The cross table is rendered through the header component (its only consumer),
// so these mount tests exercise it exactly as the matrix does.
function render(users, sortAttributes, props = {}) {
  return renderWithProviders(
    h('table', null,
      h(MatrixColumnHeaders, {
        users,
        infoColumnCount: 3,
        sortAttributes,
        headerMode: 'cross',
        ...props,
      })),
  );
}

const subject = (id, ...sortKeys) => ({ id, displayName: id, sortKeys });

// The grouping rows are every header row except the final (names) row.
const groupingRows = (container) => [...container.querySelectorAll('thead tr')].slice(0, -1);
const marksOf = (tr) => [...tr.querySelectorAll('th')]
  .slice(1)                                   // skip the corner label cell
  .flatMap(th => [...th.querySelectorAll('span[aria-hidden="true"]')].map(s => s.textContent));

describe('MatrixCrossTableRows layout', () => {
  it('renders one thin row per distinct value, with a mark in every applicable column (AC1)', () => {
    const users = [
      ...Array.from({ length: 5 }, (_, i) => subject(`e${i}`, 'Engineering')),
      ...Array.from({ length: 4 }, (_, i) => subject(`s${i}`, 'Sales')),
      ...Array.from({ length: 3 }, (_, i) => subject(`h${i}`, 'HR')),
    ];
    const { container } = render(users, [{ attribute: 'department' }]);
    const rows = groupingRows(container);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Engineering');
    expect(rows[1]).toHaveTextContent('Sales');
    expect(rows[2]).toHaveTextContent('HR');
    expect(rows[0].querySelector('th').style.height).toBe(`${VALUE_ROW_H}px`);

    // One ✕ per subject column that carries the value — not one centred mark.
    expect(marksOf(rows[0])).toEqual(Array(5).fill('✕'));
    expect(marksOf(rows[1])).toEqual(Array(4).fill('✕'));
    expect(marksOf(rows[2])).toEqual(Array(3).fill('✕'));
  });

  it('names the attribute once per level and labels an empty value (none) (AC8)', () => {
    const users = [subject('a', 'Engineering', 'Payroll'), subject('b', '', '')];
    const { container } = render(users, [{ attribute: 'ext.costCentre' }, { attribute: 'department' }]);
    const rows = groupingRows(container);

    expect(rows[0]).toHaveTextContent('Cost Centre');       // friendly label, first row of the level
    expect(rows[1]).not.toHaveTextContent('Cost Centre');   // later rows show only the value
    expect(rows[1]).toHaveTextContent('(none)');            // empty value sorts last
    expect(rows[0]).toHaveTextContent('Drag rows to reorder');
  });

  it('keeps the same value under two parents as two separate clickable runs (AC5)', async () => {
    const onToggleCollapse = vi.fn();
    const users = [
      subject('a', 'A', 'Support'), subject('b', 'A', 'Support'),
      subject('c', 'B', 'Tooling'), subject('d', 'B', 'Support'),
    ];
    const { container } = render(users, [{ attribute: 'division' }, { attribute: 'team' }], { onToggleCollapse });
    const rows = groupingRows(container);

    // Level 2 rows: Support (two runs) and Tooling.
    const supportRow = rows.find(r => r.textContent.includes('Support'));
    const runs = [...supportRow.querySelectorAll('button')];
    expect(runs).toHaveLength(2);

    runs[0].click();
    expect(onToggleCollapse).toHaveBeenCalledWith(['A', 'Support'], 1);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1); // B's Support is untouched
  });

  it('folds a group from the row it labels and unfolds it from the ▤ mark (AC6)', () => {
    const onToggleCollapse = vi.fn();
    const unfolded = [subject('a', 'Finance'), subject('b', 'Ops')];
    const { unmount } = render(unfolded, [{ attribute: 'department' }], { onToggleCollapse });
    screen.getByRole('button', { name: 'Collapse Finance into one column' }).click();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Finance'], 0);
    unmount();

    // Once folded, the aggregate column keeps the current style + the ▤ symbol,
    // and clicking it expands the group back.
    const folded = [
      { id: 'agg', isAggregateCol: true, level: 0, value: 'Finance', userCount: 2, childCounts: {}, sortKeys: ['Finance'] },
      subject('b', 'Ops'),
    ];
    const second = render(folded, [{ attribute: 'department' }], { onToggleCollapse });
    const aggRow = groupingRows(second.container)[0];
    expect(marksOf(aggRow)).toEqual(['▤']);
    expect(aggRow.querySelector('th:nth-child(2)').className).toContain('bg-indigo-50');
    screen.getByRole('button', { name: 'Expand Finance back into its columns' }).click();
    expect(onToggleCollapse).toHaveBeenCalledWith(['Finance'], 0);
  });

  it('shows the child-group count for an aggregate at the levels below its fold (AC6)', () => {
    const users = [
      { id: 'agg', isAggregateCol: true, level: 0, value: 'Finance', userCount: 9, childCounts: { 1: 6 }, sortKeys: ['Finance', '@@AGG@@agg 1'] },
      subject('b', 'Ops', 'Logistics'),
    ];
    const { container } = render(users, [{ attribute: 'division' }, { attribute: 'department' }]);
    const rows = groupingRows(container);
    const countCell = [...container.querySelectorAll('thead th')].find(th => th.textContent === '6');

    expect(countCell).toBeTruthy();
    // The count spans every value row of its level rather than repeating.
    expect(countCell.getAttribute('rowspan')).toBe(String(rows.filter(r => r.textContent.includes('Logistics')).length));
    expect(countCell.className).toContain('bg-indigo-50');
  });

  it('collapses exploded members back from their own level (AC6)', () => {
    const onToggleMembers = vi.fn();
    const users = [
      { id: 'm1', isMemberCol: true, memberLevel: 0, displayName: 'M1', sortKeys: ['Finance', ''] },
      { id: 'm2', isMemberCol: true, memberLevel: 0, displayName: 'M2', sortKeys: ['Finance', ''] },
    ];
    const { container } = render(users, [{ attribute: 'division' }, { attribute: 'department' }], { onToggleMembers, onToggleCollapse: vi.fn() });
    const rows = groupingRows(container);

    expect(marksOf(rows[0])).toEqual(['▾', '▾']);
    screen.getByRole('button', { name: 'Collapse Finance members back into a count' }).click();
    expect(onToggleMembers).toHaveBeenCalledWith(['Finance', ''], 0);
    // Below their own level the member columns carry no value row at all.
    expect(rows).toHaveLength(1);
  });

  it('exposes every run as a real button with an accessible name, and none when read-only (AC9)', () => {
    const users = [subject('a', 'Finance'), subject('b', 'Ops')];
    const { container, unmount } = render(users, [{ attribute: 'department' }], { onToggleCollapse: vi.fn() });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(container.querySelector('thead button').className).toContain('cursor-pointer');
    unmount();

    const readOnly = render(users, [{ attribute: 'department' }]);
    expect(readOnly.container.querySelectorAll('thead button')).toHaveLength(0);
    expect(readOnly.container.querySelector('thead tr th:nth-child(2)').textContent).toBe('✕');
  });

  it('ships dark-mode classes on the marks and labels (AC9)', () => {
    const { container } = render([subject('a', 'Finance')], [{ attribute: 'department' }], { onToggleCollapse: vi.fn() });
    const markCell = container.querySelector('thead tr th:nth-child(2)');
    expect(markCell.className).toContain('dark:bg-gray-800');
    expect(markCell.querySelector('button').className).toContain('dark:text-gray-300');
    expect(container.querySelector('thead tr th').className).toContain('dark:bg-gray-800');
  });
});
