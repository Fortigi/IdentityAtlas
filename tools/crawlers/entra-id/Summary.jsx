const SECRET_MASK = '••••••••';

export default function Summary({ cfg }) {
  const objectLabels = [];
  if (cfg.selectedObjects?.identity) objectLabels.push('Identity');
  if (cfg.selectedObjects?.usersGroupsMembers) objectLabels.push('Users & Groups');
  if (cfg.selectedObjects?.identityGovernance) objectLabels.push('Governance');
  if (cfg.selectedObjects?.appsAppRoles) objectLabels.push('Apps');
  if (cfg.selectedObjects?.appOwners) objectLabels.push('App Owners');
  if (cfg.selectedObjects?.appPermissions) objectLabels.push('App Permissions');
  if (cfg.selectedObjects?.directoryRoles) objectLabels.push('Dir Roles');

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
        <div><span className="text-gray-500 dark:text-gray-400">Tenant ID:</span> <span className="font-mono text-xs dark:text-gray-300">{cfg.tenantId || '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Client ID:</span> <span className="font-mono text-xs dark:text-gray-300">{cfg.clientId || '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Secret:</span> <span className="text-gray-600 dark:text-gray-500">{SECRET_MASK}</span></div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">Objects:</span>{' '}
          {objectLabels.length > 0
            ? objectLabels.map(l => <span key={l} className="inline-block mr-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded dark:bg-blue-900/30 dark:text-blue-300">{l}</span>)
            : <span className="text-gray-600 text-xs dark:text-gray-500">none</span>
          }
        </div>
      </div>

      {cfg.identityFilter?.attribute && (
        <div className="text-xs text-gray-500 mb-1 dark:text-gray-400">
          <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded dark:bg-purple-900/30 dark:text-purple-300">
            Identity filter: {cfg.identityFilter.attribute} {cfg.identityFilter.condition}
            {cfg.identityFilter.value && ` "${cfg.identityFilter.value}"`}
            {cfg.identityFilter.values?.length > 0 && ` ${JSON.stringify(cfg.identityFilter.values)}`}
          </span>
        </div>
      )}

      {(cfg.customUserAttributes?.length > 0 || cfg.customGroupAttributes?.length > 0 || cfg.identityAttributes?.length > 0) && (
        <div className="text-xs text-gray-500 flex flex-wrap gap-1 dark:text-gray-400">
          {cfg.identityAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded dark:bg-amber-900/30 dark:text-amber-300">
              +{cfg.identityAttributes.length} identity attr{cfg.identityAttributes.length > 1 ? 's' : ''}
            </span>
          )}
          {cfg.customUserAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded dark:bg-amber-900/30 dark:text-amber-300">
              +{cfg.customUserAttributes.length} user attr{cfg.customUserAttributes.length > 1 ? 's' : ''}
            </span>
          )}
          {cfg.customGroupAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded dark:bg-amber-900/30 dark:text-amber-300">
              +{cfg.customGroupAttributes.length} group attr{cfg.customGroupAttributes.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
