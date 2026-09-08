// Snapshot helpers for matrix share links (#1166).
//
// A share records HOW the sharer was looking at the matrix alongside WHAT they
// were looking at, so a recipient sees the same thing — including the rotated
// view (#1049) and the roll-up. Which view renders is derived from the filter
// (MatrixArea reads `filter.orientation` / the roll-up keys), so the stored
// display mode is folded back into the filter rather than threaded as a second
// source of truth the two could disagree on.

export const ROTATED_ORIENTATION = 'rows-as-subjects';

// The display mode a filter currently represents: 'rollup' | 'rotated' | 'grid'.
export function displayModeOf(filter) {
  if (!filter) return 'grid';
  if (filter.rollup || (filter.rollupKind === 'context' && filter.rollupContextId)) return 'rollup';
  return filter.orientation === ROTATED_ORIENTATION ? 'rotated' : 'grid';
}

// The filter as it should render for a stored display mode. A null/absent mode
// (an older share, or one stored before the mode was known) leaves the filter
// untouched — the filter's own orientation still decides.
export function applyDisplayMode(filter, mode) {
  if (!filter) return null;
  if (mode === 'rotated') return { ...filter, orientation: ROTATED_ORIENTATION };
  if (mode === 'grid' && filter.orientation === ROTATED_ORIENTATION) {
    const { orientation: _dropped, ...rest } = filter;
    return rest;
  }
  return filter;
}
