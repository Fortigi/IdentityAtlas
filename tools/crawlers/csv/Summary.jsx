import { delimiterLabel, mappedPairs } from './csvMapping.js';

// The per-file delimiters a config records, as "name (delimiter)" strings. Empty
// when the config has no per-file section — then the single config-level
// delimiter is the whole truth, exactly as it was before mapping existed.
export function perFileDelimiters(cfg) {
  return Object.entries(cfg?.files || {})
    .map(([name, entry]) => `${name} (${delimiterLabel(entry?.delimiter || cfg.delimiter)})`)
    .sort();
}

// How many source columns the config maps onto schema fields, across all files.
export function mappedColumnCount(cfg) {
  return Object.values(cfg?.files || {}).reduce((n, entry) => n + mappedPairs(entry?.columns).length, 0);
}

export default function Summary({ cfg }) {
  const perFile = perFileDelimiters(cfg);
  const mapped = mappedColumnCount(cfg);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
      <div><span className="text-gray-500 dark:text-gray-400">System:</span> <span className="font-medium dark:text-gray-200">{cfg.systemName || '—'}</span></div>
      <div><span className="text-gray-500 dark:text-gray-400">Type:</span> <span className="font-mono text-xs dark:text-gray-300">{cfg.systemType || '—'}</span></div>
      <div><span className="text-gray-500 dark:text-gray-400">Delimiter:</span> <code className="text-xs dark:text-gray-300">{delimiterLabel(cfg.delimiter)}</code></div>
      {cfg.sourceFormat === 'custom' && (
        <div><span className="text-gray-500 dark:text-gray-400">Mapping:</span> <span className="text-xs dark:text-gray-300">{mapped} mapped column{mapped === 1 ? '' : 's'}</span></div>
      )}
      {perFile.length > 0 && (
        <div className="col-span-2 text-xs text-gray-500 dark:text-gray-400">Per file: {perFile.join(', ')}</div>
      )}
    </div>
  );
}
