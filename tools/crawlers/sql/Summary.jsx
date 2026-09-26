const SECRET_MASK = '••••••••';
const TYPE_DEFAULT = 'SQL Database';

/**
 * The system name the run will register (tools/crawlers/shared/Get-CrawlerSystemName.ps1):
 * explicit override ▸ crawler name ▸ type default. A stored override equal to
 * the type default counts as unset, so the card shows the name the run uses (#1240).
 */
export function resolveSystemName(cfg, config) {
  const override = (cfg?.systemName || '').trim();
  if (override && override !== TYPE_DEFAULT) return override;
  return (config?.displayName || '').trim() || TYPE_DEFAULT;
}

// How many source columns a slot renames onto the column contract; 0 when the
// SELECT already returns contract names (the normal case).
function mappedCount(query) {
  const columnMap = query?.columnMap;
  return columnMap && typeof columnMap === 'object' ? Object.keys(columnMap).length : 0;
}

function serverLabel(cfg) {
  if (!cfg.server) return '—';
  return cfg.port ? `${cfg.server}:${cfg.port}` : cfg.server;
}

export default function Summary({ cfg, config }) {
  const queries = (cfg.queries || []).filter(q => q.enabled !== false);

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
        <div className="col-span-2">
          <span className="text-gray-500 dark:text-gray-400">Server:</span>{' '}
          <span className="font-mono text-xs dark:text-gray-300">{serverLabel(cfg)}</span>
        </div>
        <div><span className="text-gray-500 dark:text-gray-400">Database:</span> <span className="dark:text-gray-300">{cfg.database || '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">System:</span> <span className="dark:text-gray-300">{resolveSystemName(cfg, config)}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Username:</span> <span className="dark:text-gray-300">{cfg.username || '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Password:</span> <span className="text-gray-600 dark:text-gray-500">{SECRET_MASK}</span></div>
        <div className="col-span-2">
          <span className="text-gray-500 dark:text-gray-400">Queries:</span>{' '}
          {queries.length > 0
            ? queries.map((q, i) => (
              <span key={`${q.name}-${i}`} className="inline-block mr-1 mb-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded dark:bg-blue-900/30 dark:text-blue-300">
                {q.name} → {q.target}
                {mappedCount(q) > 0 && <span className="ml-1 opacity-70">+{mappedCount(q)} mapped</span>}
              </span>
            ))
            : <span className="text-gray-600 text-xs dark:text-gray-500">none enabled</span>}
        </div>
      </div>
    </div>
  );
}
