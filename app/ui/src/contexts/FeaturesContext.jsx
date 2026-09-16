// The optional-feature flags (/api/features), as App.jsx already loads them.
//
// App fetches the flags once and re-fetches on navigation (see the pageCtx note
// in App.jsx: /api/features sits behind the public rate limiter, so components
// must not each fetch it). Pages get them as a prop; components deep inside the
// matrix — the wizard, the toolbar — read them from here instead of having the
// flags drilled through every view.
//
// Default `{}`: outside the provider every flag reads as off, so a component
// mounted somewhere App does not reach (the share recipient's shell) never
// offers a feature it cannot confirm is on.

import { createContext, useContext } from 'react';

export const FeaturesContext = createContext({});

export function useFeatureFlags() {
  return useContext(FeaturesContext);
}
