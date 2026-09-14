// Grid controls that sit in the grid's own header corner, at the axis they act
// on, instead of in the toolbar above the grid (#1202):
//
//   - ColumnAxisControls — top-left corner: the "?" legend, and ONE fold/unfold
//     toggle for every top-level column group;
//   - RowAxisControls — the corner above the row labels: expand/collapse nested
//     groups, fold/unfold business roles, and reset a custom row order.
//
// Each toggle is a single button whose icon, aria-pressed and accessible name
// follow the ACTUAL state, so there is never a "Fold" button left on screen for
// something already folded. Controls that don't apply render nothing. Shared by
// the flat (MatrixView) and roll-up (RollupMatrixView) grids.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import MatrixLegend from './MatrixLegend';
import { usePopover } from './usePopover';

const BASE_BTN = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 dark:focus-visible:ring-blue-400 dark:focus-visible:ring-offset-gray-800';
const IDLE_BTN = 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const ACTIVE_BTN = 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-200 dark:hover:bg-blue-900/60';

// Stroke paths (24×24, heroicons-outline geometry) for the corner icons.
const ICONS = {
  foldColumns: 'M3 12h6m0 0-3-3m3 3-3 3M21 12h-6m0 0 3-3m-3 3 3 3M12 5v14',
  unfoldColumns: 'M9 12H3m0 0 3-3m-3 3 3 3M15 12h6m0 0-3-3m3 3-3 3M12 5v14',
  expandRows: 'm19.5 5.25-7.5 7.5-7.5-7.5m15 6-7.5 7.5-7.5-7.5',
  collapseRows: 'm4.5 18.75 7.5-7.5 7.5 7.5m-15-6 7.5-7.5 7.5 7.5',
  foldRoles: 'M12 3v6m0 0-3-3m3 3 3-3M12 21v-6m0 0-3 3m3-3 3 3M5 12h14',
  unfoldRoles: 'M12 9V3m0 0L9 6m3-3 3 3M12 15v6m0 0-3-3m3 3 3-3M5 12h14',
  resetOrder: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3',
};

function Icon({ name }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

// A 24px icon button. `pressed` (true / false / 'mixed') makes it a toggle.
export function CornerIconButton({ label, title, pressed, onClick, children, ...rest }) {
  const active = pressed === true || pressed === 'mixed';
  return (
    <button type="button" aria-label={label} title={title || label} aria-pressed={pressed} onClick={onClick}
      className={`${BASE_BTN} ${active ? ACTIVE_BTN : IDLE_BTN}`} {...rest}>
      {children}
    </button>
  );
}

// A toggle whose label/icon/handler flip with `on`.
function FlipToggle({ on, pressed = on, onLabel, offLabel, onIcon, offIcon, onTitle, offTitle, onTurnOff, onTurnOn }) {
  return (
    <CornerIconButton label={on ? onLabel : offLabel} title={on ? onTitle : offTitle}
      pressed={pressed} onClick={on ? onTurnOff : onTurnOn}>
      <Icon name={on ? onIcon : offIcon} />
    </CornerIconButton>
  );
}

// Fold every top-level column group into a count column, or unfold them all.
// `foldState`: 'all' (pressed → unfold), 'some' (mixed → fold the rest), 'none'.
export function ColumnFoldToggle({ canFold, foldState = 'none', onFoldAll, onUnfoldAll }) {
  if (!canFold) return null;
  const all = foldState === 'all';
  return (
    <FlipToggle on={all} pressed={foldState === 'some' ? 'mixed' : all}
      onLabel="Unfold all columns" offLabel="Fold all columns"
      onIcon="unfoldColumns" offIcon="foldColumns"
      onTitle="Unfold all columns back to individual subjects"
      offTitle="Fold every top-level column group into a single count column"
      onTurnOff={onUnfoldAll} onTurnOn={onFoldAll} />
  );
}

// Where the legend popover goes: under the trigger, kept inside the viewport.
// Fixed-positioned and portalled, so the grid's scroll container can't clip it.
const PANEL_W = 544;
function panelPosition(trigger) {
  const r = trigger.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8));
  return { top: r.bottom + 4, left };
}

// "?" — opens the matrix legend ("How to read this matrix") as a popover.
export function MatrixLegendButton({ showBusinessRoles = false }) {
  const { open, toggle, triggerRef, panelRef } = usePopover();
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const onClick = () => {
    if (!open && triggerRef.current) setPos(panelPosition(triggerRef.current));
    toggle();
  };
  return (
    <>
      <CornerIconButton ref={triggerRef} label="How to read this matrix" aria-expanded={open}
        aria-haspopup="dialog" onClick={onClick}>
        <span aria-hidden="true">?</span>
      </CornerIconButton>
      {open && createPortal(
        <div ref={panelRef} role="dialog" aria-label="How to read this matrix" tabIndex={-1}
          className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 text-left font-normal shadow-lg focus:outline-none dark:border-gray-700 dark:bg-gray-800"
          style={{ top: pos.top, left: pos.left, width: PANEL_W, maxWidth: 'calc(100vw - 16px)' }}>
          <div className="mb-2 text-xs font-semibold text-gray-800 dark:text-gray-100">How to read this matrix</div>
          <MatrixLegend showBusinessRoles={showBusinessRoles} />
        </div>,
        document.body,
      )}
    </>
  );
}

// Top-left corner: the legend, plus the column fold toggle where it applies.
export function ColumnAxisControls({ showBusinessRoles, canFoldColumns, columnFoldState, onFoldAllColumns, onUnfoldAllColumns }) {
  return (
    <div className="flex items-center gap-1">
      <MatrixLegendButton showBusinessRoles={showBusinessRoles} />
      <ColumnFoldToggle canFold={canFoldColumns} foldState={columnFoldState}
        onFoldAll={onFoldAllColumns} onUnfoldAll={onUnfoldAllColumns} />
    </div>
  );
}

function NestedGroupsToggle({ show, expanded, onExpandAll, onCollapseAll }) {
  if (!show) return null;
  return (
    <FlipToggle on={expanded}
      onLabel="Collapse nested groups" offLabel="Expand nested groups"
      onIcon="collapseRows" offIcon="expandRows"
      offTitle="Expand all nested groups (up to 4 levels)"
      onTurnOff={onCollapseAll} onTurnOn={onExpandAll} />
  );
}

function RoleFoldToggle({ show, folded, onFoldAll, onUnfoldAll }) {
  if (!show) return null;
  return (
    <FlipToggle on={folded}
      onLabel="Unfold business roles" offLabel="Fold business roles"
      onIcon="unfoldRoles" offIcon="foldRoles"
      onTitle="Unfold all business roles and show their resources again"
      offTitle="Fold every business role — leaves only business roles and resources no role grants"
      onTurnOff={onUnfoldAll} onTurnOn={onFoldAll} />
  );
}

// Corner above the row labels. Renders nothing when no row control applies.
export function RowAxisControls({
  hasNestedGroups = false, hasExpandedGroups = false, onExpandAll, onCollapseAll,
  canFoldRoles = false, hasFoldedRoles = false, onFoldAllRoles, onUnfoldAllRoles,
  hasCustomRowOrder = false, onResetRowOrder,
}) {
  if (!hasNestedGroups && !canFoldRoles && !hasCustomRowOrder) return null;
  return (
    <div className="flex items-center gap-1">
      <NestedGroupsToggle show={hasNestedGroups} expanded={hasExpandedGroups}
        onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} />
      <RoleFoldToggle show={canFoldRoles} folded={hasFoldedRoles}
        onFoldAll={onFoldAllRoles} onUnfoldAll={onUnfoldAllRoles} />
      {hasCustomRowOrder && (
        <CornerIconButton label="Reset row order" title="Reset row order to default" onClick={onResetRowOrder}>
          <Icon name="resetOrder" />
        </CornerIconButton>
      )}
    </div>
  );
}
