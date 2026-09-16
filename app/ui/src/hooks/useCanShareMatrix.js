// May the current user create matrix share links? (#1166)
//
// Two conditions, both required: the install has the `matrixSharing` feature
// flag on (Admin → Experimental), and the user holds `data.share`. Every place
// that offers sharing — the wizard's Share step, the matrix bar's share control,
// the Admin → Shared Matrices tab — asks this one hook, so the flag cannot be
// honoured in one place and forgotten in another.

import { useHasPermission } from '@ui/auth/usePermissions';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

export function useCanShareMatrix() {
  const hasPermission = useHasPermission('data.share');
  return useFeatureFlags().matrixSharing === true && hasPermission;
}
