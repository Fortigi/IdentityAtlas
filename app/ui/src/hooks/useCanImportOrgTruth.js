// May the current user import organisation truth (upload a list, run the wizard,
// accept links)?
//
// Two conditions, both required: the install has the `orgTruth` feature flag on
// (Admin → Experimental), and the user holds `data.write.contexts` — the same
// permission the context assistant uses, because an import ends in generated
// contexts. Reading the Organisation tab needs only the flag (and data.read).

import { useHasPermission } from '@ui/auth/usePermissions';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

export function useCanImportOrgTruth() {
  const hasPermission = useHasPermission('data.write.contexts');
  return useFeatureFlags().orgTruth === true && hasPermission;
}
