// @vitest-environment jsdom
//
// The grid's corner controls (#1202). Each toggle is ONE button whose name,
// aria-pressed and handler follow the real state — the bug they replace was a
// "Fold columns" button that stayed on screen after folding. So every toggle
// is asserted in both states, with the OTHER handler checked as not called: a
// toggle wired to the same handler in both states would otherwise pass.

import { describe, it, expect, vi } from 'vitest';
import {
  ColumnFoldToggle, ColumnAxisControls, ColumnLevelControls, RowAxisControls, MatrixLegendButton,
} from './GridCornerControls';
import { renderWithProviders, screen, userEvent, fireEvent } from '@ui/test-utils/renderWithProviders';

describe('ColumnFoldToggle', () => {
  it('offers "Fold all columns" (not pressed) when nothing is folded, and folds on click', async () => {
    const onFoldAll = vi.fn();
    const onUnfoldAll = vi.fn();
    renderWithProviders(<ColumnFoldToggle canFold foldState="none" onFoldAll={onFoldAll} onUnfoldAll={onUnfoldAll} />);

    const btn = screen.getByRole('button', { name: 'Fold all columns' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(onFoldAll).toHaveBeenCalledTimes(1);
    expect(onUnfoldAll).not.toHaveBeenCalled();
  });

  it('offers "Unfold all columns" (pressed) when every group is folded, and unfolds on click', async () => {
    const onFoldAll = vi.fn();
    const onUnfoldAll = vi.fn();
    renderWithProviders(<ColumnFoldToggle canFold foldState="all" onFoldAll={onFoldAll} onUnfoldAll={onUnfoldAll} />);

    const btn = screen.getByRole('button', { name: 'Unfold all columns' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Fold all columns' })).not.toBeInTheDocument();
    await userEvent.click(btn);
    expect(onUnfoldAll).toHaveBeenCalledTimes(1);
    expect(onFoldAll).not.toHaveBeenCalled();
  });

  // Partly folded is neither on nor off: say so (mixed), and fold the rest.
  it('reports a partly folded axis as mixed and folds the rest on click', async () => {
    const onFoldAll = vi.fn();
    const onUnfoldAll = vi.fn();
    renderWithProviders(<ColumnFoldToggle canFold foldState="some" onFoldAll={onFoldAll} onUnfoldAll={onUnfoldAll} />);

    const btn = screen.getByRole('button', { name: 'Fold all columns' });
    expect(btn).toHaveAttribute('aria-pressed', 'mixed');
    await userEvent.click(btn);
    expect(onFoldAll).toHaveBeenCalledTimes(1);
    expect(onUnfoldAll).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no foldable column groups', () => {
    const { container } = renderWithProviders(<ColumnFoldToggle canFold={false} foldState="all" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ColumnLevelControls', () => {
  const fold = () => screen.getByRole('button', { name: 'Fold all columns one level' });
  const unfold = () => screen.getByRole('button', { name: 'Unfold all columns one level' });

  // The whole point of the control: ONE level per click, not a jump to the
  // deepest attribute. A handler wired to 1 / maxLevel would pass a
  // "was it called" assertion, so the argument is what's pinned.
  it('steps the axis one level at a time, in both directions', async () => {
    const onSetLevel = vi.fn();
    renderWithProviders(<ColumnLevelControls level={2} maxLevel={4} onSetLevel={onSetLevel} />);

    await userEvent.click(fold());
    expect(onSetLevel).toHaveBeenCalledWith(1);
    await userEvent.click(unfold());
    expect(onSetLevel).toHaveBeenCalledWith(3);
    expect(onSetLevel).toHaveBeenCalledTimes(2);
  });

  it('shows where in the axis you are', () => {
    renderWithProviders(<ColumnLevelControls level={2} maxLevel={4} onSetLevel={vi.fn()} />);
    expect(screen.getByText('2/4')).toBeInTheDocument();
    expect(fold()).toHaveAttribute('title', expect.stringContaining('Showing 2 of 4 levels'));
  });

  it('stops at the top level instead of folding past it', async () => {
    const onSetLevel = vi.fn();
    renderWithProviders(<ColumnLevelControls level={1} maxLevel={3} onSetLevel={onSetLevel} />);
    expect(fold()).toBeDisabled();
    expect(unfold()).toBeEnabled();
    await userEvent.click(fold());
    expect(onSetLevel).not.toHaveBeenCalled();     // level 0 would be no columns at all
  });

  it('stops at the deepest level instead of unfolding past it', async () => {
    const onSetLevel = vi.fn();
    renderWithProviders(<ColumnLevelControls level={3} maxLevel={3} onSetLevel={onSetLevel} />);
    expect(unfold()).toBeDisabled();
    expect(fold()).toBeEnabled();
    await userEvent.click(unfold());
    expect(onSetLevel).not.toHaveBeenCalled();
  });

  it('renders nothing when the axis has no levels to walk', () => {
    // A single-attribute roll-up and every non-layered shape: one level is not
    // an axis, and 0/0 is what the server sends when there is no fold at all.
    for (const props of [{ level: 1, maxLevel: 1 }, { level: 0, maxLevel: 0 }, { level: 0, maxLevel: 3 }]) {
      const { container, unmount } = renderWithProviders(<ColumnLevelControls {...props} onSetLevel={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe('ColumnAxisControls', () => {
  it('always offers the legend, and the fold toggle only when columns can fold', () => {
    const { rerender } = renderWithProviders(<ColumnAxisControls canFoldColumns={false} />);
    expect(screen.getByRole('button', { name: 'How to read this matrix' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /all columns/ })).not.toBeInTheDocument();

    rerender(<ColumnAxisControls canFoldColumns columnFoldState="none" />);
    expect(screen.getByRole('button', { name: 'Fold all columns' })).toBeInTheDocument();
  });

  it('adds the level stepper only for a grid that has fold levels', () => {
    const { rerender } = renderWithProviders(<ColumnAxisControls canFoldColumns columnFoldState="none" />);
    expect(screen.queryByRole('button', { name: /one level/ })).not.toBeInTheDocument();

    rerender(<ColumnAxisControls foldLevel={2} foldMaxLevel={3} onSetFoldLevel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Fold all columns one level' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unfold all columns one level' })).toBeInTheDocument();
    // The two models are alternatives, not a stack: the roll-up has no
    // one-shot fold toggle to show next to the stepper.
    expect(screen.queryByRole('button', { name: 'Fold all columns' })).not.toBeInTheDocument();
  });
});

describe('RowAxisControls', () => {
  const handlers = () => ({
    onExpandAll: vi.fn(), onCollapseAll: vi.fn(),
    onFoldAllRoles: vi.fn(), onUnfoldAllRoles: vi.fn(),
    onResetRowOrder: vi.fn(),
  });

  it('renders nothing when no row control applies', () => {
    const { container } = renderWithProviders(<RowAxisControls hasExpandedGroups hasFoldedRoles {...handlers()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('expands nested groups while none are expanded', async () => {
    const h = handlers();
    renderWithProviders(<RowAxisControls hasNestedGroups {...h} />);
    const btn = screen.getByRole('button', { name: 'Expand nested groups' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(h.onExpandAll).toHaveBeenCalledTimes(1);
    expect(h.onCollapseAll).not.toHaveBeenCalled();
    // Only the nested toggle applies here.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('collapses nested groups once some are expanded', async () => {
    const h = handlers();
    renderWithProviders(<RowAxisControls hasNestedGroups hasExpandedGroups {...h} />);
    const btn = screen.getByRole('button', { name: 'Collapse nested groups' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(h.onCollapseAll).toHaveBeenCalledTimes(1);
    expect(h.onExpandAll).not.toHaveBeenCalled();
  });

  it('folds business roles while none are folded, and unfolds them once folded', async () => {
    const h = handlers();
    const { rerender } = renderWithProviders(<RowAxisControls canFoldRoles {...h} />);
    const fold = screen.getByRole('button', { name: 'Fold business roles' });
    expect(fold).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(fold);
    expect(h.onFoldAllRoles).toHaveBeenCalledTimes(1);
    expect(h.onUnfoldAllRoles).not.toHaveBeenCalled();

    rerender(<RowAxisControls canFoldRoles hasFoldedRoles {...h} />);
    const unfold = screen.getByRole('button', { name: 'Unfold business roles' });
    expect(unfold).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Fold business roles' })).not.toBeInTheDocument();
    await userEvent.click(unfold);
    expect(h.onUnfoldAllRoles).toHaveBeenCalledTimes(1);
    expect(h.onFoldAllRoles).toHaveBeenCalledTimes(1);
  });

  it('offers Reset row order only after a custom order, as a plain (non-toggle) button', async () => {
    const h = handlers();
    const { rerender } = renderWithProviders(<RowAxisControls canFoldRoles {...h} />);
    expect(screen.queryByRole('button', { name: 'Reset row order' })).not.toBeInTheDocument();

    rerender(<RowAxisControls hasCustomRowOrder {...h} />);
    const reset = screen.getByRole('button', { name: 'Reset row order' });
    expect(reset).not.toHaveAttribute('aria-pressed');
    await userEvent.click(reset);
    expect(h.onResetRowOrder).toHaveBeenCalledTimes(1);
  });

  it('shows all three together when all apply', () => {
    renderWithProviders(<RowAxisControls hasNestedGroups canFoldRoles hasCustomRowOrder {...handlers()} />);
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual(['Expand nested groups', 'Fold business roles', 'Reset row order']);
  });
});

describe('MatrixLegendButton', () => {
  const trigger = () => screen.getByRole('button', { name: 'How to read this matrix' });
  const dialog = () => screen.queryByRole('dialog', { name: 'How to read this matrix' });

  it('opens the legend on click, moves focus into it, and closes on a second click', async () => {
    renderWithProviders(<MatrixLegendButton />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(dialog()).not.toBeInTheDocument();

    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveTextContent('Cell badges — how the access is held');
    expect(dialog()).toHaveFocus();

    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the button', async () => {
    renderWithProviders(<MatrixLegendButton />);
    await userEvent.click(trigger());
    expect(dialog()).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(dialog()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  // Other keys must not close it — only Escape does.
  it('stays open on other keys', async () => {
    renderWithProviders(<MatrixLegendButton />);
    await userEvent.click(trigger());
    await userEvent.keyboard('a');
    expect(dialog()).toBeInTheDocument();
  });

  it('closes on a click outside, but not on a click inside the legend', async () => {
    renderWithProviders(<div><MatrixLegendButton /><p>elsewhere</p></div>);
    await userEvent.click(trigger());

    fireEvent.mouseDown(dialog().querySelector('div'));
    expect(dialog()).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(dialog()).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the business-role markers only when the grid has business-role rows', async () => {
    const { unmount } = renderWithProviders(<MatrixLegendButton />);
    await userEvent.click(trigger());
    expect(dialog()).not.toHaveTextContent('folded business role');
    unmount();

    renderWithProviders(<MatrixLegendButton showBusinessRoles />);
    await userEvent.click(trigger());
    expect(dialog()).toHaveTextContent('folded business role');
  });

  // Portalled with fixed coordinates so the grid's scroll box can't clip it;
  // placed under the trigger and pulled back inside a narrow viewport.
  it('positions the legend under its button, kept inside the viewport', async () => {
    renderWithProviders(<MatrixLegendButton />);
    trigger().getBoundingClientRect = () => ({ left: 900, bottom: 50, top: 26, right: 924, width: 24, height: 24 });
    const prevWidth = window.innerWidth;
    window.innerWidth = 1000;
    try {
      await userEvent.click(trigger());
      expect(dialog().parentElement).toBe(document.body);
      expect(dialog().style.top).toBe('54px');
      // 1000 - 544 - 8: the panel's right edge stays 8px inside the window.
      expect(dialog().style.left).toBe('448px');
    } finally {
      window.innerWidth = prevWidth;
    }
  });

  it('never places the legend off the left edge of the window', async () => {
    renderWithProviders(<MatrixLegendButton />);
    trigger().getBoundingClientRect = () => ({ left: -30, bottom: 10, top: -14, right: -6, width: 24, height: 24 });
    await userEvent.click(trigger());
    expect(dialog().style.left).toBe('8px');
  });
});
