// @vitest-environment jsdom
//
// Add Crawler → Select Type, against the experimentalCrawlers feature flag.
// The rule: an experimental crawler type is offered only while the flag is on,
// and when it is offered it is visibly badged. Runs against the REAL discovered
// crawler metadata, so this also fails if SCIM's experimental flag is dropped.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import SelectType from './CrawlersPage.SelectType.jsx';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

function render(experimentalEnabled, onSelect = vi.fn()) {
  renderWithProviders(h(SelectType, { onSelect, onCancel: vi.fn(), experimentalEnabled }));
  return onSelect;
}

describe('SelectType', () => {
  it('omits the experimental SCIM type while the flag is off, but still offers the stable ones', () => {
    render(false);
    expect(screen.getByText('Microsoft Graph')).toBeInTheDocument();
    expect(screen.queryByText('SCIM 2.0')).not.toBeInTheDocument();
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
  });

  it('offers SCIM, badged Experimental, once the flag is on', () => {
    render(true);
    expect(screen.getByText('SCIM 2.0')).toBeInTheDocument();
    expect(screen.getByText('Experimental')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Graph')).toBeInTheDocument();
  });

  it('treats a missing flag value as off — the picker fails closed while /api/features loads', () => {
    render(undefined);
    expect(screen.queryByText('SCIM 2.0')).not.toBeInTheDocument();
  });

  it('selects the type that was clicked', async () => {
    const onSelect = render(true);
    await userEvent.click(screen.getByText('SCIM 2.0'));
    expect(onSelect).toHaveBeenCalledWith('scim');
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
