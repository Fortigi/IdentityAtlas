// Shared-view mode (#1166).
//
// A matrix opened through a share link renders inside a deliberately bare
// shell: the recipient is a business user (a team manager, a resource owner),
// not an analyst. Rather than forking the matrix and detail components, the
// shell flips this flag and the handful of analyst-only affordances inside
// them opt out — one flag, read at the few places that own a control, instead
// of a parallel set of "shared" components kept in sync by hand.
//
// Default false: every existing mount of those components is unaffected.

import { createContext, useContext } from 'react';

export const SharedViewContext = createContext(false);

// True when the surrounding shell is a share link's read-only view.
export function useIsSharedView() {
  return useContext(SharedViewContext);
}
