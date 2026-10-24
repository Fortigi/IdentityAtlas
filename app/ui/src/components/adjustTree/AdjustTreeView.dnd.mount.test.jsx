// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { renderWithProviders, screen, act } from '@ui/test-utils/renderWithProviders';
import { TREE } from '@ui/test-utils/adjustTreeFixtures';
import AdjustTreeView from './AdjustTreeView';
import { TOP_LEVEL_DROP_ID } from './adjustTree.helpers';

// jsdom has no layout, so a real pointer drag never finds a drop target. The
// DndContext is replaced by a pass-through that keeps its handlers, and the
// test drives a drag through them the way dnd-kit would: start, then end over
// a droppable id. What is asserted is what the tree does with a drop.
const dnd = vi.hoisted(() => ({ props: null }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DndContext: (props) => { dnd.props = props; return props.children; } };
});


function mount(props = {}) {
  const onDrop = vi.fn();
  renderWithProviders(h(AdjustTreeView, {
    units: TREE.units, targetType: 'Principal', editable: true, selectedId: null, onSelect: () => {},
    onDrop, checked: new Set(), onCheck: () => {}, version: 0, ...props,
  }));
  return { onDrop };
}

const unitDrag = (unitId, name) => ({ active: { data: { current: { type: 'unit', unitId, name } } } });

function drag(start, overId) {
  act(() => dnd.props.onDragStart(start));
  act(() => dnd.props.onDragEnd({ ...start, over: overId == null ? null : { id: overId } }));
}

beforeEach(() => { dnd.props = null; });

describe('AdjustTreeView — dropping', () => {
  it('offers the top-level zone only while a unit is dragged', () => {
    mount();
    expect(screen.queryByText(/drop here to move the unit to the top/)).not.toBeInTheDocument();
    act(() => dnd.props.onDragStart(unitDrag('u-fin', 'Finance')));
    expect(screen.getByText(/drop here to move the unit to the top/)).toBeInTheDocument();
    act(() => dnd.props.onDragCancel());
    expect(screen.queryByText(/drop here to move the unit to the top/)).not.toBeInTheDocument();
  });

  it('hands a unit dropped on another unit to the page as a move', () => {
    const { onDrop } = mount();
    drag(unitDrag('u-fin', 'Finance'), 'u-it');
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toEqual({ op: 'moveUnit', subjectId: 'u-fin', toParentId: 'u-it' });
  });

  it('moves to the top level from the zone, and refuses a drop into its own sub-unit', () => {
    const { onDrop } = mount();
    drag(unitDrag('u-fin', 'Finance'), TOP_LEVEL_DROP_ID);
    drag(unitDrag('u-board', 'Board'), 'u-acc');
    expect(onDrop.mock.calls.map(c => c[0])).toEqual([
      { op: 'moveUnit', subjectId: 'u-fin', toParentId: null },
      { error: "You can't move a unit into one of its own sub-units." },
    ]);
  });

  it('does nothing for a drop outside the tree or back on the unit\'s own parent', () => {
    const { onDrop } = mount();
    drag(unitDrag('u-fin', 'Finance'), null);
    drag(unitDrag('u-fin', 'Finance'), 'u-board');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('hands a member dropped on another unit to the page as a member move', () => {
    const { onDrop } = mount();
    drag({ active: { data: { current: { type: 'member', memberId: 'p-saar', fromUnitId: 'u-board', name: 'Saar Dekker' } } } }, 'u-fin');
    expect(onDrop.mock.calls[0][0]).toEqual({ op: 'moveMember', memberId: 'p-saar', fromUnitId: 'u-board', toUnitId: 'u-fin' });
  });

  it('opens the unit something was dropped on', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Collapse Accounting' })).not.toBeInTheDocument();
    // Accounting has no children, so drop on Finance after closing it.
    act(() => screen.getByRole('button', { name: 'Collapse Finance' }).click());
    expect(screen.getByRole('button', { name: 'Expand Finance' })).toBeInTheDocument();
    drag(unitDrag('u-it', 'IT'), 'u-fin');
    expect(screen.getByRole('button', { name: 'Collapse Finance' })).toBeInTheDocument();
  });

  it('has no drag and drop at all when read only', () => {
    mount({ editable: false });
    expect(dnd.props).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /^Pick/ })).not.toBeInTheDocument();
  });
});
