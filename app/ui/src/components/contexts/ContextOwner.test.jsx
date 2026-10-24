// @vitest-environment jsdom
//
// The cases that matter are the two a real dataset produces: an owner the API
// resolved to a principal, and one it could not (the SQL catalogue that stores
// an employee number where principals are keyed on the identity id). The second
// one is the reason this component exists at all — the owner was there, correct,
// and nothing on screen said so.
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextOwner from './ContextOwner';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const RESOLVED = { ownerUserId: 'IIQ-4711', ownerPrincipalId: 'p-1', ownerDisplayName: 'Leo M. Cohen' };
const UNRESOLVED = { ownerUserId: '10000737', ownerPrincipalId: null, ownerDisplayName: null };

describe('ContextOwner', () => {
  it('shows the person, not the id, when the owner resolved', () => {
    renderWithProviders(h(ContextOwner, { attrs: RESOLVED, onOpenDetail: () => {} }));
    expect(screen.getByText('Owner:', { exact: false }).textContent).toContain('Leo M. Cohen');
    expect(screen.queryByText(/IIQ-4711/)).not.toBeInTheDocument();
  });

  it('opens the owner account when clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextOwner, { attrs: RESOLVED, onOpenDetail }));
    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-1', 'Leo M. Cohen');
  });

  it('falls back to the raw value when the owner resolves to nobody, and does not link it', () => {
    renderWithProviders(h(ContextOwner, { attrs: UNRESOLVED, onOpenDetail: () => {} }));
    // The raw value is rendered — blanking it would hide that the source names
    // an owner we cannot find.
    expect(screen.getByText('Owner:', { exact: false }).textContent).toContain('10000737');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the resolved name unlinked when there is nowhere to navigate', () => {
    renderWithProviders(h(ContextOwner, { attrs: RESOLVED }));
    expect(screen.getByText('Owner:', { exact: false }).textContent).toContain('Leo M. Cohen');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the link when a resolved principal has no display name, labelling it with the raw id', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextOwner, { attrs: { ownerUserId: 'IIQ-9', ownerPrincipalId: 'p-9' }, onOpenDetail }));
    await userEvent.click(screen.getByRole('button'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-9', 'IIQ-9');
  });

  it('renders nothing at all when the context has no owner, or no attributes yet', () => {
    const { container } = renderWithProviders(h(ContextOwner, { attrs: { ownerUserId: null }, onOpenDetail: () => {} }));
    expect(container.textContent).toBe('');
    // The detail page mounts the header before its fetch resolves, so attrs can
    // legitimately be undefined — that must render empty, not throw.
    const bare = renderWithProviders(h(ContextOwner, { onOpenDetail: () => {} }));
    expect(bare.container.textContent).toBe('');
  });
});
