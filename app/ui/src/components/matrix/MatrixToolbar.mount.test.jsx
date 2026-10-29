// @vitest-environment jsdom
//
// The toolbar row above the matrix carries only the lens and Export (#1202).
// Everything that acts on one axis of the grid moved into the grid's corner
// (GridCornerControls), and Copy link is gone — so this pins the whole set of
// buttons, not merely that the remaining ones exist.

import { describe, it, expect, vi } from 'vitest';
import MatrixToolbar from './MatrixToolbar';
import { renderWithProviders, screen, userEvent, fireEvent } from '@ui/test-utils/renderWithProviders';

function renderToolbar(props = {}, options) {
  const setManagedFilter = vi.fn();
  const onExportExcel = vi.fn();
  renderWithProviders(
    <div>
      <MatrixToolbar managedFilter="all" setManagedFilter={setManagedFilter} onExportExcel={onExportExcel} {...props} />
      <p>elsewhere</p>
    </div>,
    options,
  );
  return { setManagedFilter, onExportExcel };
}

const exportButton = () => screen.getByRole('button', { name: /^Export/ });

describe('MatrixToolbar', () => {
  it('holds only the lens and Export — no Copy link, no grid controls', () => {
    renderToolbar();
    expect(screen.getAllByRole('button').map(b => b.textContent.trim()))
      .toEqual(['All', 'Governed', 'Non-governed', 'Gaps', 'Export ▾']);
  });

  it('highlights the active lens and switches it on click', async () => {
    const { setManagedFilter } = renderToolbar({ managedFilter: 'managed' });
    expect(screen.getByRole('button', { name: 'Governed' }).className).toContain('bg-blue-600');
    expect(screen.getByRole('button', { name: 'All' }).className).not.toContain('bg-blue-600');
    await userEvent.click(screen.getByRole('button', { name: 'Gaps' }));
    expect(setManagedFilter).toHaveBeenCalledWith('gaps');
  });

  it('offers "+ Proposed roles" only when asked — a toggle beside the four lenses, not a lens', async () => {
    const onToggleProposed = vi.fn();
    const { setManagedFilter } = renderToolbar({ showProposed: true, onToggleProposed });
    expect(screen.getAllByRole('button').map(b => b.textContent.trim()))
      .toEqual(['All', 'Governed', 'Non-governed', 'Gaps', '+ Proposed roles', 'Export ▾']);
    const toggle = screen.getByRole('button', { name: '+ Proposed roles' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(onToggleProposed).toHaveBeenCalledWith(true);
    expect(setManagedFilter).not.toHaveBeenCalled();
  });

  it('keeps the lens and every lens switch while it is on, and turns it off', async () => {
    const onToggleProposed = vi.fn();
    const { setManagedFilter } = renderToolbar({ showProposed: true, proposedOn: true, managedFilter: 'managed', onToggleProposed });
    expect(screen.getByRole('button', { name: 'Governed' }).className).toContain('bg-blue-600');
    expect(screen.getByRole('button', { name: '+ Proposed roles' })).toHaveAttribute('aria-pressed', 'true');
    for (const [label, key] of [['All', 'all'], ['Governed', 'managed'], ['Non-governed', 'unmanaged'], ['Gaps', 'gaps']]) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      expect(setManagedFilter).toHaveBeenLastCalledWith(key);
    }
    await userEvent.click(screen.getByRole('button', { name: '+ Proposed roles' }));
    expect(onToggleProposed).toHaveBeenCalledWith(false);
  });

  it('drops Gaps when the view has no gap data', () => {
    renderToolbar({ hideGaps: true });
    expect(screen.queryByRole('button', { name: 'Gaps' })).not.toBeInTheDocument();
  });

  it('opens the Export menu, exports Excel from it and closes', async () => {
    const { onExportExcel } = renderToolbar();
    expect(exportButton()).toHaveAttribute('aria-haspopup', 'menu');
    expect(exportButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem', { name: 'Export Excel' })).not.toBeInTheDocument();

    await userEvent.click(exportButton());
    expect(exportButton()).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('menuitem', { name: 'Export Excel' });
    expect(item).toHaveFocus();
    expect(onExportExcel).not.toHaveBeenCalled();

    await userEvent.click(item);
    expect(onExportExcel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the Export menu on Escape (focus back on Export) and on an outside click', async () => {
    const { onExportExcel } = renderToolbar();
    await userEvent.click(exportButton());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(exportButton()).toHaveFocus();

    await userEvent.click(exportButton());
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onExportExcel).not.toHaveBeenCalled();
  });

  it('offers no Export without the export permission', () => {
    renderToolbar({}, { auth: { hasWildcard: false, permissions: new Set(['data.read']), permissionsLoaded: true } });
    expect(screen.queryByRole('button', { name: /^Export/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });
});
