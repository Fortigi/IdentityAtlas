// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import DetailRoute from './DetailRoute';

// The Adjust tree tab's route: the page gets the tree key from the hash, the
// cache hook (to relabel a tab opened from a URL) and a Close that closes this
// tab. The page itself is replaced by a probe that shows what it was given.
vi.mock('@ui/components/adjustTree/AdjustTreePage', () => ({
  default: ({ treeKey, onCacheData, cachedData, onClose }) => (
    <div>
      <span data-testid="tree-key">{treeKey}</span>
      <span data-testid="has-cache">{String(typeof onCacheData === 'function')}</span>
      <span data-testid="cached">{cachedData?.displayName || ''}</span>
      <button type="button" onClick={onClose}>close-probe</button>
    </div>
  ),
}));

function mount(page, cache = {}) {
  const closeDetailTab = vi.fn();
  const onCacheData = vi.fn();
  renderWithProviders(
    <Suspense fallback={<span>loading</span>}>
      <DetailRoute page={page} detailCacheRef={{ current: cache }} onCacheData={onCacheData} openDetailTab={vi.fn()} closeDetailTab={closeDetailTab} />
    </Suspense>,
  );
  return { closeDetailTab };
}

describe('DetailRoute — adjust-tree', () => {
  it('opens the Adjust tree page on the key after the first colon, with the cache hook', async () => {
    const { closeDetailTab } = mount('adjust-tree:generated:abc', { 'adjust-tree:generated:abc': { displayName: 'Adjust: Org' } });
    expect(await screen.findByTestId('tree-key')).toHaveTextContent('generated:abc');
    expect(screen.getByTestId('has-cache')).toHaveTextContent('true');
    expect(screen.getByTestId('cached')).toHaveTextContent('Adjust: Org');
    await userEvent.setup().click(screen.getByRole('button', { name: 'close-probe' }));
    expect(closeDetailTab).toHaveBeenCalledWith('adjust-tree', 'generated:abc');
  });

  it('renders nothing for a page that is not a detail route', () => {
    const { container } = renderWithProviders(<DetailRoute page="matrix" detailCacheRef={{ current: {} }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
