// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextMemberPicker from './ContextMemberPicker';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';

describe('ContextMemberPicker (mounted)', () => {
  it('shows a fallback for a target type with no search endpoint', () => {
    renderWithProviders(
      h(ContextMemberPicker, { contextId: 'c1', targetType: 'Nope', existingMemberIds: [] }),
      { auth: { authFetch: makeAuthFetch({}) } },
    );
    expect(screen.getByText(/No search endpoint for target type/i)).toBeInTheDocument();
  });

  it('debounce-searches, lists results, and adds one', async () => {
    const onAdded = vi.fn();
    const authFetch = makeAuthFetch((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/identities') && (opts.method || 'GET') === 'GET') {
        return { data: [{ id: 'i1', displayName: 'Alice' }] };
      }
      if (u.includes('/members') && opts.method === 'POST') return { ok: true };
      return {};
    });
    renderWithProviders(
      h(ContextMemberPicker, { contextId: 'c1', targetType: 'Identity', onAdded, existingMemberIds: [] }),
      { auth: { authFetch } },
    );
    const user = userEvent.setup();

    // Query by accessible name (aria-label), not placeholder — guards #761.
    await user.type(screen.getByRole('textbox', { name: /Search identitys to add/i }), 'Ali');
    // After the 250ms debounce the result row renders.
    expect(await screen.findByText('Alice')).toBeInTheDocument();

    await user.click(screen.getByText('Alice'));
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/contexts/c1/members'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onAdded).toHaveBeenCalled();
  });
});
