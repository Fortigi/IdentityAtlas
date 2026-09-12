// @vitest-environment jsdom
//
// Add Crawler → Select Type, against the experimentalCrawlers feature flag.
// The rule: an experimental crawler type is offered only while the flag is on,
// and when it is offered it is visibly badged.
//
// Runs against the REAL discovered registry but names no crawler type — the
// expected names are read from the registry, so this keeps working as types come
// and go (and keeps app/ui/ free of type literals, which the crawler-manifest CI
// gate requires). A type's own experimental flag is pinned in its own folder.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import SelectType from './CrawlersPage.SelectType.jsx';
import { experimentalCrawlerTypes, selectableCrawlerTypes } from '@ui/utils/crawlerMetaRegistry';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const EXPERIMENTAL = experimentalCrawlerTypes();
const STABLE = selectableCrawlerTypes(false);

function render(experimentalEnabled, onSelect = vi.fn()) {
  renderWithProviders(h(SelectType, { onSelect, onCancel: vi.fn(), experimentalEnabled }));
  return onSelect;
}

describe('SelectType', () => {
  it('omits every experimental type while the flag is off, but still offers the stable ones', () => {
    render(false);
    for (const t of STABLE) expect(screen.getByText(t.name), t.id).toBeInTheDocument();
    for (const t of EXPERIMENTAL) expect(screen.queryByText(t.name), t.id).not.toBeInTheDocument();
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
  });

  it('offers the experimental types, each badged, once the flag is on', () => {
    render(true);
    for (const t of EXPERIMENTAL) expect(screen.getByText(t.name), t.id).toBeInTheDocument();
    for (const t of STABLE) expect(screen.getByText(t.name), t.id).toBeInTheDocument();
    expect(screen.getAllByText('Experimental')).toHaveLength(EXPERIMENTAL.length);
  });

  it('treats a missing flag value as off — the picker fails closed while /api/features loads', () => {
    render(undefined);
    for (const t of EXPERIMENTAL) expect(screen.queryByText(t.name), t.id).not.toBeInTheDocument();
  });

  it('selects the type that was clicked, experimental included', async () => {
    const onSelect = render(true);
    await userEvent.click(screen.getByText(EXPERIMENTAL[0].name));
    expect(onSelect).toHaveBeenCalledWith(EXPERIMENTAL[0].id);
  });

  it('cancels without selecting anything', async () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    renderWithProviders(h(SelectType, { onSelect, onCancel, experimentalEnabled: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// The not-yet-available tiles: no shipped crawler produces them today, so these
// inject a type list rather than leaving the rendering untested until one does.
describe('SelectType — a type that cannot be chosen yet', () => {
  const COMING = [
    { id: 'ready', name: 'Ready One', description: 'usable today', available: true },
    { id: 'later', name: 'Later One', description: 'not yet', available: false, comingSoon: true },
  ];

  it('badges it Coming soon and disables its tile', () => {
    renderWithProviders(h(SelectType, { onSelect: vi.fn(), onCancel: vi.fn(), types: COMING }));
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByText('Later One').closest('button')).toBeDisabled();
    expect(screen.getByText('Ready One').closest('button')).toBeEnabled();
  });

  it('does not select it when clicked', async () => {
    const onSelect = vi.fn();
    renderWithProviders(h(SelectType, { onSelect, onCancel: vi.fn(), types: COMING }));
    await userEvent.click(screen.getByText('Later One'));
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('Ready One'));
    expect(onSelect).toHaveBeenCalledWith('ready');
  });
});
