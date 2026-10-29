// @vitest-environment jsdom
//
// Add Crawler → Select Type, against the experimentalCrawlers feature flag.
// The rule: an experimental crawler type is offered only while the flag is on,
// and when it is offered it is visibly badged.
//
// Runs the REAL registry selectors over a neutral fixture registry rather than
// the discovered one: which shipped types are experimental changes over time —
// at times none are — and a gate test must not go vacuous when that happens.
// The fixture names no real crawler type, keeping app/ui/ free of type literals
// (the crawler-manifest CI gate requires that). A type's own experimental flag
// is pinned in its own folder.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';

const { REGISTRY } = vi.hoisted(() => ({
  REGISTRY: [
    { id: 'stable-one', name: 'Stable One', description: 'an ordinary type', available: true },
    { id: 'preview-one', name: 'Preview One', description: 'not yet proven', experimental: true, available: true },
    { id: 'stable-two', name: 'Stable Two', description: 'another ordinary type', available: true },
  ],
}));

vi.mock('@ui/utils/crawlerMetaRegistry', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    CRAWLER_TYPES: REGISTRY,
    experimentalCrawlerTypes: (types = REGISTRY) => real.experimentalCrawlerTypes(types),
    selectableCrawlerTypes: (enabled, types = REGISTRY) => real.selectableCrawlerTypes(enabled, types),
  };
});

import SelectType from './CrawlersPage.SelectType.jsx';
import { experimentalCrawlerTypes, selectableCrawlerTypes } from '@ui/utils/crawlerMetaRegistry';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const EXPERIMENTAL = experimentalCrawlerTypes();
const STABLE = selectableCrawlerTypes(false);

it('the fixture has both kinds, so every assertion below discriminates', () => {
  expect(EXPERIMENTAL.map(t => t.id)).toEqual(['preview-one']);
  expect(STABLE.map(t => t.id)).toEqual(['stable-one', 'stable-two']);
});

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
