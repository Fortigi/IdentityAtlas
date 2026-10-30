// @vitest-environment jsdom
// The grid's header sticks to the page while its body may scroll sideways inside
// itself: the header strip follows the body's horizontal scroll, and its row
// labels move back so they stay put. Both tables share the column widths.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@ui/test-utils/renderWithProviders';
import PageStickyTable from './PageStickyTable';

function mount() {
  renderWithProviders(
    <PageStickyTable label="Grid" widths={[100, 24, 24]}
      head={<tr><th data-sticky-left>Label</th><th>A</th><th>B</th></tr>}>
      <tr><th>Row</th><td>1</td><td>2</td></tr>
    </PageStickyTable>,
  );
  const region = screen.getByRole('region', { name: 'Grid' });
  const [headTable, bodyTable] = region.querySelectorAll('table');
  return { region, headTable, bodyTable, body: bodyTable.parentElement };
}

describe('PageStickyTable', () => {
  it('puts the header in a strip that sticks to the page, the body below as the named table, both with the same columns', () => {
    const { region, headTable, bodyTable } = mount();
    const strip = region.querySelector('[data-sticky-head]');
    expect(strip.className).toContain('sticky');
    expect(strip.className).toContain('top-0');
    expect(strip.style.overflowX).toBe('clip');
    expect(screen.getByRole('table', { name: 'Grid' })).toBe(bodyTable);
    for (const t of [headTable, bodyTable]) {
      expect(t.style.width).toBe('148px');
      expect([...t.querySelectorAll('col')].map(c => c.style.width)).toEqual(['100px', '24px', '24px']);
    }
    expect(headTable.querySelector('thead')).toHaveTextContent('LabelAB');
    expect(bodyTable.querySelector('tbody')).toHaveTextContent('Row12');
  });

  it('moves the header with the body\'s sideways scroll, keeping the row labels in place, and back', () => {
    const { headTable, body } = mount();
    const label = headTable.querySelector('[data-sticky-left]');
    body.scrollLeft = 40;
    fireEvent.scroll(body);
    expect(headTable.style.transform).toBe('translateX(-40px)');
    expect(label.style.transform).toBe('translateX(40px)');
    body.scrollLeft = 0;
    fireEvent.scroll(body);
    expect(headTable.style.transform).toBe('');
    expect(label.style.transform).toBe('');
  });
});
