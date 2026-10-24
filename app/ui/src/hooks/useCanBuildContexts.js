// May the current user build contexts with the context assistant?
//
// Two conditions, both required: the install has the `contextAssistant` feature flag on
// (Admin → Experimental), and the user holds `data.write.contexts`. The new-context
// wizard's "Describe it" option and the context builder tab both ask this one hook.

import { useHasPermission } from '@ui/auth/usePermissions';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

export function useCanBuildContexts() {
  const hasPermission = useHasPermission('data.write.contexts');
  return useFeatureFlags().contextAssistant === true && hasPermission;
}
