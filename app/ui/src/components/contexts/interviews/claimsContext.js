import { createContext, useContext } from 'react';

// The claims of the context on screen, shared by the "What we know" section,
// the People block's interview suggestions and the "Upload interview" card, so
// a decision in one refreshes the others. ClaimsProvider fills it; outside a
// provider (a page without a template profile) it is null and the consumers
// show nothing.
export const ClaimsContext = createContext(null);

export function useContextClaims() {
  return useContext(ClaimsContext);
}
