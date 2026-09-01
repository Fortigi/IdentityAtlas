// @vitest-environment jsdom
//
// The app-root hook that warms the attribute-label cache (issue #872). What
// matters is that a surface rendered BEFORE the map arrives re-renders with the
// clean name once it does — the raw key must not be what the user is left with.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor } from '@ui/test-utils/renderWithProviders';
import { attributeLabel, resetAttributeLabels } from '@ui/utils/attributeLabels';
import { useAttributeLabels } from './useAttributeLabels';

const KEY = 'extension_8ce8d3db3b314def88d829e15494e83f_sfTeamID';

function Probe() {
  useAttributeLabels();
  return h('span', null, attributeLabel(KEY) || KEY);
}

beforeEach(() => resetAttributeLabels());
afterEach(() => resetAttributeLabels());

describe('useAttributeLabels', () => {
  it('re-renders the consumer with the clean name once the map arrives', async () => {
    const authFetch = makeAuthFetch({ '/api/attribute-labels': { labels: { [KEY]: 'sfTeamID' } } });

    renderWithProviders(h(Probe), { auth: { authFetch } });

    // First paint has no map yet — the raw key.
    expect(screen.getByText(KEY)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('sfTeamID')).toBeInTheDocument());
    expect(authFetch).toHaveBeenCalledWith('/api/attribute-labels');
  });

  it('leaves the raw key rendered when the endpoint fails, without throwing (AC11)', async () => {
    const authFetch = makeAuthFetch({
      '/api/attribute-labels': jsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
    });

    renderWithProviders(h(Probe), { auth: { authFetch } });

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(screen.getByText(KEY)).toBeInTheDocument();
  });

  it('fetches once even when several consumers mount', async () => {
    const authFetch = makeAuthFetch({ '/api/attribute-labels': { labels: { [KEY]: 'sfTeamID' } } });

    renderWithProviders(h('div', null, h(Probe), h(Probe)), { auth: { authFetch } });

    await waitFor(() => expect(screen.getAllByText('sfTeamID')).toHaveLength(2));
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('does not set state after the consumer unmounts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolve;
    const authFetch = vi.fn(() => new Promise(r => { resolve = r; }));

    const { unmount } = renderWithProviders(h(Probe), { auth: { authFetch } });
    unmount();
    resolve(jsonResponse({ labels: { [KEY]: 'sfTeamID' } }));
    await Promise.resolve();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
