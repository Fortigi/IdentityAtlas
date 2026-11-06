// @vitest-environment jsdom
// Rows virtualised against the page: the rows near the window, and the spacers
// above and below — measured from where the grid's body starts on the page.
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const seen = vi.hoisted(() => ({ opts: null, window: [2, 3, 4] }));
vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (opts) => {
    seen.opts = opts;
    const h = opts.estimateSize();
    return {
      getVirtualItems: () => seen.window.map(index => ({ index, start: opts.scrollMargin + index * h, end: opts.scrollMargin + (index + 1) * h })),
      getTotalSize: () => opts.count * h,
    };
  },
}));

import { usePageVirtualRows } from './usePageVirtualRows';

function Probe({ count, top }) {
  const ref = useRef(null);
  const { items, padTop, padBottom } = usePageVirtualRows(ref, count, 10);
  return (
    <div ref={ref} data-top={top} data-testid="body">
      <span data-testid="out">{`${items.map(i => i.index).join(',')}|${padTop}|${padBottom}`}</span>
    </div>
  );
}

describe('usePageVirtualRows', () => {
  it('renders the rows near the window, with spacers measured from where the body starts on the page', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      return { top: Number(this.dataset?.top ?? 0), left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    });
    renderWithProviders(<Probe count={10} top={300} />);
    expect(seen.opts).toMatchObject({ count: 10, overscan: 20, scrollMargin: 300 });
    // Rows 2–4 of 10 at 10px each: 20px above them, 50px below.
    expect(screen.getByTestId('out')).toHaveTextContent('2,3,4|20|50');
    vi.restoreAllMocks();
  });

  it('has no spacers when nothing is rendered', () => {
    seen.window = [];
    renderWithProviders(<Probe count={0} top={0} />);
    expect(screen.getByTestId('out')).toHaveTextContent('|0|0');
    seen.window = [2, 3, 4];
  });
});
