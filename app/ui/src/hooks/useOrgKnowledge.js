// Is organisation knowledge on for this install? (Admin → Experimental, flag
// `orgKnowledge`.) Interviews and other sources, the claims read from them,
// contradictions and decisions only show while it is; with it off a unit's page is
// a plain unit page. The API answers 404 on every claims / interviews endpoint
// then, so nothing asks it.

import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

export function useOrgKnowledge() {
  return useFeatureFlags().orgKnowledge === true;
}
