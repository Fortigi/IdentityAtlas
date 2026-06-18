export default function Summary({ cfg }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
      <div><span className="text-gray-500 dark:text-gray-400">System:</span> <span className="font-medium dark:text-gray-200">{cfg.systemName || '—'}</span></div>
      <div><span className="text-gray-500 dark:text-gray-400">Type:</span> <span className="font-mono text-xs dark:text-gray-300">{cfg.systemType || '—'}</span></div>
      <div><span className="text-gray-500 dark:text-gray-400">Delimiter:</span> <code className="text-xs dark:text-gray-300">{cfg.delimiter === '\t' ? '\\t' : (cfg.delimiter || ';')}</code></div>
    </div>
  );
}
