export const ASSIGNMENT_TYPE_STYLES = {
  'Auto-assigned':                    'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border-green-200 dark:border-green-700',
  'Request-based':                    'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-700',
  'Request-based with auto-removal':  'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-700',
  'Both':                             'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-700',
};

// Access-package resource-role → matrix badge. Group ownership is its own
// resource (resourceType='GroupOwnership') since v5, so a role scope only ever
// resolves to Member (rendered as Direct) or Eligible — the same mapping the
// governed-intent view applies to `ResourceRelationships.roleName`. Shared by
// the on-screen matrix and the Excel export so the two can't drift apart.
export const AP_ROLE_BADGE_DIRECT   = { letter: 'D', bg: '#166534', text: '#fff' };
export const AP_ROLE_BADGE_ELIGIBLE = { letter: 'E', bg: '#854d0e', text: '#fff' };

export function getApRoleBadge(roleName) {
  return (roleName || '').toLowerCase().includes('eligible')
    ? AP_ROLE_BADGE_ELIGIBLE
    : AP_ROLE_BADGE_DIRECT;
}

// Review-compliance badge styles — shared by the Business Roles list and the
// detail page's Overview so the badge/colour is identical in both.
export const COMPLIANCE_STYLES = {
  'Compliant':     'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700',
  'In Progress':   'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  'Missed':        'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
  'Reviewed Late': 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
};
