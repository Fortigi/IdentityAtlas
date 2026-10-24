// May the current user build custom reports?
//
// Two conditions, both required: the install has the `customReports` feature flag
// on (Admin → Experimental), and the user holds `data.write.reports`. Everywhere
// that offers building — the Reports page's New report / Edit / Delete, the report
// builder tab — asks this one hook.

import { useHasPermission } from '@ui/auth/usePermissions';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

export function useCanBuildReports() {
  const hasPermission = useHasPermission('data.write.reports');
  return useFeatureFlags().customReports === true && hasPermission;
}
