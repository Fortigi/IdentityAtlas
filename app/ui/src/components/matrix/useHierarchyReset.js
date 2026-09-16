import { useState } from 'react';

// Run `reset()` during render when the selected sort-hierarchy transitions to
// none — React's "adjust state when a prop changes" pattern, without an effect
// (which would trip react-hooks/set-state-in-effect). Keeps the branch out of the
// MatrixView component body. `reset` is only invoked when no hierarchy is selected.
export function useHierarchyReset(sortHierarchyId, reset) {
  const [seen, setSeen] = useState(sortHierarchyId);
  if (sortHierarchyId !== seen) {
    setSeen(sortHierarchyId);
    if (!sortHierarchyId) reset();
  }
}
