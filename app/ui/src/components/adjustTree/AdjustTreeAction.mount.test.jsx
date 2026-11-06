// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor } from '@ui/test-utils/renderWithProviders';
import { AdjustTreeMenuItem } from './AdjustTreeAction';
import { resolveState, adjustTabTitle } from './useTreeResolve';

const RESOLVE = '/api/context-trees/resolve?contextId=c-1';
const READY = { treeKey: 'org:1', kind: 'generated', name: 'Organisation', targetType: 'Principal', canAdjust: true };
const BLOCKED = { ...READY, kind: 'synced', canAdjust: false, reason: 'This tree is maintained in its source' };

function mount(Comp, body, props = {}) {
  const onOpen = vi.fn();
  const onDone = vi.fn();
  const authFetch = makeAuthFetch({ [RESOLVE]: body });
  renderWithProviders(h(Comp, { contextId: 'c-1', className: 'x', onOpen, onDone, ...props }), { auth: { authFetch } });
  return { onOpen, onDone, authFetch, user: userEvent.setup() };
}

describe('resolveState / adjustTabTitle', () => {
  it('turns the resolve answer into what the action shows', () => {
    expect(resolveState({ data: READY, loading: false, error: null })).toEqual({ state: 'ready', reason: null });
    expect(resolveState({ data: BLOCKED, loading: false, error: null })).toEqual({ state: 'blocked', reason: 'This tree is maintained in its source' });
    expect(resolveState({ data: { canAdjust: false }, loading: false, error: null }).reason).toBe('This tree cannot be adjusted here.');
    expect(resolveState({ data: null, loading: true, error: null }).state).toBe('loading');
    expect(resolveState({ data: READY, loading: false, error: new Error('x') }).state).toBe('failed');
    expect(adjustTabTitle('Organisation')).toBe('Adjust: Organisation');
    expect(adjustTabTitle(undefined)).toBe('Adjust: tree');
  });
});

describe('AdjustTreeMenuItem', () => {
  it('opens the tree\'s Adjust tree tab and closes the menu', async () => {
    const { onOpen, onDone, user, authFetch } = mount(AdjustTreeMenuItem, READY);
    const item = screen.getByRole('menuitem', { name: /Adjust tree/ });
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled'));
    await user.click(item);
    expect(onOpen).toHaveBeenCalledWith('org:1', 'Adjust: Organisation');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith(RESOLVE);
  });

  it('stays disabled with the reason when the tree cannot be adjusted', async () => {
    const { onOpen, user } = mount(AdjustTreeMenuItem, BLOCKED);
    expect(await screen.findByText('This tree is maintained in its source')).toBeInTheDocument();
    const item = screen.getByRole('menuitem', { name: /Adjust tree/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.click(item);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('says the check failed when the API does not answer', async () => {
    mount(AdjustTreeMenuItem, jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    expect(await screen.findByText('Could not check whether this tree can be adjusted.')).toBeInTheDocument();
  });
});
