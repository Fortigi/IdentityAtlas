// @vitest-environment jsdom
//
// DetailRoute maps a detail hash to its page and the props it hands over. The
// pages are lazy and heavy, so each is a probe that prints what it received.
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';
import DetailRoute from './DetailRoute';

function probe(name) {
  return {
    default: (props) => (
      <div data-testid="page">
        {name} {JSON.stringify(Object.keys(props).sort())}
        <span data-testid="id">{props.entityId ?? props.contextId ?? props.runId}</span>
        <button type="button" onClick={props.onClose}>close</button>
        <button type="button" onClick={() => props.onOpenDetail('user', 'u1', 'U')}>open</button>
      </div>
    ),
  };
}
vi.mock('@ui/components/orgtruth/OrgEntityDetailPage', () => probe('OrgEntityDetailPage'));
vi.mock('@ui/components/ContextDetailPage', () => probe('ContextDetailPage'));
vi.mock('@ui/components/RunDetailPage', () => probe('RunDetailPage'));

function render(page) {
  const props = {
    page,
    detailCacheRef: { current: { 'org-entity:e1': { displayName: 'Northwind Portal' } } },
    onCacheData: vi.fn(),
    openDetailTab: vi.fn(),
    closeDetailTab: vi.fn(),
  };
  const r = renderWithProviders(<Suspense fallback={<p>loading</p>}><DetailRoute {...props} /></Suspense>);
  return { ...props, ...r };
}

describe('DetailRoute', () => {
  it('renders the org-entity detail page with its id, cache and handlers', async () => {
    const { closeDetailTab, openDetailTab } = render('org-entity:e1');
    const page = await screen.findByTestId('page');
    expect(page).toHaveTextContent('OrgEntityDetailPage');
    expect(page).toHaveTextContent('["cachedData","entityId","onCacheData","onClose","onOpenDetail"]');
    expect(screen.getByTestId('id')).toHaveTextContent('e1');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(closeDetailTab).toHaveBeenCalledWith('org-entity', 'e1');
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(openDetailTab).toHaveBeenCalledWith('user', 'u1', 'U');
  });

  it('keeps the existing routes: a context by contextId, a run without the cache', async () => {
    render('context:c1');
    expect(await screen.findByTestId('id')).toHaveTextContent('c1');
    expect(screen.getByTestId('page')).toHaveTextContent('ContextDetailPage');
  });

  it('gives a run no cache props', async () => {
    render('run:r1');
    expect(await screen.findByTestId('page')).toHaveTextContent('["onClose","onOpenDetail","runId"]');
  });

  it('renders nothing for a static page', () => {
    const { container } = render('organisation');
    expect(container).toBeEmptyDOMElement();
  });
});
