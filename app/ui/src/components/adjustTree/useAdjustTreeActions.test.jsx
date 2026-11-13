// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, makeWrapper, screen, act, within, userEvent } from '@ui/test-utils/renderWithProviders';
import { useAdjustTreeActions } from './useAdjustTreeActions';

// The page's actions on top of the data hook: what each one writes, and what
// the user is told. The data hook is a stub here; its own routes are covered
// by the mounted page tests.

function fakeData(overrides = {}) {
  return {
    post: vi.fn(async (body) => ({ id: 'n1', description: `Did ${body.op}` })),
    groupUnits: vi.fn(async () => [{ id: 'g1', description: 'Added Support' }, { id: 'g2' }, { id: 'g3' }]),
    undo: vi.fn(async () => ({})),
    redo: vi.fn(async () => ({})),
    follow: vi.fn(async () => ({})),
    ...overrides,
  };
}

function setup(data = fakeData(), select = vi.fn()) {
  const { result } = renderHook(() => useAdjustTreeActions(data, { select }), { wrapper: makeWrapper().wrapper });
  return { actions: result.current, data, select };
}

const toastWith = async (text) => (await screen.findByText(text)).closest('[role="status"]');

describe('useAdjustTreeActions', () => {
  it('posts a drop that is a move, and shows a refused drop without writing', async () => {
    const { actions, data } = setup();
    let ok;
    await act(async () => { ok = await actions.drop({ error: 'Not into its own sub-unit' }); });
    expect(ok).toBe(false);
    expect(data.post).not.toHaveBeenCalled();
    expect(await screen.findByText('Not into its own sub-unit')).toBeInTheDocument();
    await act(async () => { ok = await actions.drop({ op: 'moveUnit', subjectId: 'a', toParentId: 'b' }); });
    expect(ok).toBe(true);
    expect(data.post).toHaveBeenCalledWith({ op: 'moveUnit', subjectId: 'a', toParentId: 'b' });
    expect(await screen.findByText('Did moveUnit')).toBeInTheDocument();
  });

  it('undoes every adjustment a grouping made, newest first', async () => {
    const { actions, data } = setup();
    await act(async () => { await actions.group({ name: 'Support', parentId: null, unitIds: ['x', 'y'] }); });
    const toast = await toastWith('Added Support');
    await userEvent.setup().click(within(toast).getByRole('button', { name: 'Undo' }));
    await screen.findByText('Undone');
    expect(data.undo.mock.calls.map(c => c[0])).toEqual(['g3', 'g2', 'g1']);
  });

  it('reports a failed write and resolves false', async () => {
    const { actions } = setup(fakeData({ post: vi.fn(async () => { throw new Error('Unit not found'); }) }));
    let ok;
    await act(async () => { ok = await actions.post({ op: 'renameUnit' }); });
    expect(ok).toBe(false);
    expect(await screen.findByText('Unit not found')).toBeInTheDocument();
  });

  it('reports an undo that fails half way', async () => {
    const undo = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Already undone'));
    const { actions } = setup(fakeData({ undo }));
    await act(async () => { await actions.group({ name: 'S', parentId: null, unitIds: ['x'] }); });
    await userEvent.setup().click(within(await toastWith('Added Support')).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Already undone')).toBeInTheDocument();
    expect(undo).toHaveBeenCalledTimes(2);
  });

  it('dispatches each Needs attention fix to its own write', async () => {
    const { actions, data, select } = setup();
    await act(async () => {
      await actions.attention({ type: 'follow', adjustmentId: 'f1' });
      await actions.attention({ type: 'remove', adjustmentId: 'r1' });
      await actions.attention({ type: 'split', subjectId: 'u1', attribute: 'department', value: 'Data' });
      await actions.attention({ type: 'select', unitId: 'u7' });
    });
    expect(data.follow).toHaveBeenCalledWith('f1');
    expect(data.undo).toHaveBeenCalledWith('r1');
    expect(data.post).toHaveBeenCalledWith({ op: 'splitUnit', subjectId: 'u1', attribute: 'department', value: 'Data' });
    expect(select).toHaveBeenCalledWith('u7');
    let ok;
    await act(async () => { ok = await actions.attention({ type: 'teleport' }); });
    expect(ok).toBe(false);
  });

  it('offers no Undo when the API returned no adjustment to undo', async () => {
    const { actions } = setup(fakeData({ post: vi.fn(async () => ({})) }));
    await act(async () => { await actions.post({ op: 'addUnit' }); });
    const toast = await toastWith('Unit added');
    expect(within(toast).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('says what an undo, redo or follow did, or why it failed', async () => {
    const { actions, data } = setup(fakeData({ redo: vi.fn(async () => { throw new Error('Gone'); }) }));
    await act(async () => { await actions.undo({ id: 'a1', description: 'Move IT' }); });
    expect(data.undo).toHaveBeenCalledWith('a1');
    expect(await screen.findByText('Undone: Move IT')).toBeInTheDocument();
    await act(async () => { await actions.follow({ id: 'a2' }); });
    expect(data.follow).toHaveBeenCalledWith('a2');
    let ok;
    await act(async () => { ok = await actions.redo({ id: 'a3', description: 'X' }); });
    expect(ok).toBe(false);
    expect(await screen.findByText('Gone')).toBeInTheDocument();
  });
});
