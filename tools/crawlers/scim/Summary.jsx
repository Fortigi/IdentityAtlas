const SECRET_MASK = '••••••••';

const OBJECT_LABELS = [
  ['users', 'Users'],
  ['groups', 'Groups'],
  ['groupMembers', 'Members'],
];

export default function Summary({ cfg }) {
  const objects = OBJECT_LABELS.filter(([key]) => cfg.selectedObjects?.[key]).map(([, label]) => label);
  const userAttrs = cfg.selectedAttributes?.user?.length || 0;
  const groupAttrs = cfg.selectedAttributes?.group?.length || 0;
  const mappedTypes = (cfg.userTypeMapping || []).filter(m => m.userType).length;

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
        <div className="col-span-2">
          <span className="text-gray-500 dark:text-gray-400">Endpoint:</span>{' '}
          <span className="font-mono text-xs dark:text-gray-300">{cfg.baseUrl || '—'}</span>
        </div>
        <div><span className="text-gray-500 dark:text-gray-400">Auth:</span> <span className="dark:text-gray-300">{cfg.authMethod || '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Secret:</span> <span className="text-gray-600 dark:text-gray-500">{SECRET_MASK}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">System:</span> <span className="dark:text-gray-300">{cfg.systemName || 'SCIM'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Page size:</span> <span className="dark:text-gray-300">{cfg.pageSize || 100}</span></div>
        <div className="col-span-2">
          <span className="text-gray-500 dark:text-gray-400">Objects:</span>{' '}
          {objects.length > 0
            ? objects.map(l => <span key={l} className="inline-block mr-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded dark:bg-blue-900/30 dark:text-blue-300">{l}</span>)
            : <span className="text-gray-600 text-xs dark:text-gray-500">none</span>}
        </div>
      </div>

      {(userAttrs > 0 || groupAttrs > 0 || mappedTypes > 0) && (
        <div className="text-xs text-gray-500 flex flex-wrap gap-1 dark:text-gray-400">
          {userAttrs > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded dark:bg-amber-900/30 dark:text-amber-300">
              +{userAttrs} user attr{userAttrs > 1 ? 's' : ''}
            </span>
          )}
          {groupAttrs > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded dark:bg-amber-900/30 dark:text-amber-300">
              +{groupAttrs} group attr{groupAttrs > 1 ? 's' : ''}
            </span>
          )}
          {mappedTypes > 0 && (
            <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded dark:bg-purple-900/30 dark:text-purple-300">
              {mappedTypes} user-type rule{mappedTypes > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
