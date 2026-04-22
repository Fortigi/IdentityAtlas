// JsonViewer — Syntax-highlighted, collapsible JSON display
// Used in RiskProfileWizard for profile and classifier JSON

import { useState } from 'react';

function JsonNode({ data, depth = 0, label = null }) {
  const [collapsed, setCollapsed] = useState(depth > 1);
  const isArray = Array.isArray(data);
  const isObject = data !== null && typeof data === 'object' && !isArray;
  const isExpandable = isArray || isObject;

  if (!isExpandable) {
    return (
      <span>
        {label && <span className="text-blue-600 dark:text-blue-400">{JSON.stringify(label)}: </span>}
        <Value value={data} />
      </span>
    );
  }

  const entries = isArray
    ? data.map((v, i) => [i, v])
    : Object.entries(data);
  const preview = isArray
    ? `Array(${data.length})`
    : `Object(${entries.length})`;
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <div
        onClick={() => setCollapsed(!collapsed)}
        className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 rounded px-1 -mx-1 inline-block select-none"
      >
        <span className="text-gray-400 dark:text-gray-500 mr-1">{collapsed ? '▶' : '▼'}</span>
        {label && <span className="text-blue-600 dark:text-blue-400">{JSON.stringify(label)}: </span>}
        <span className="text-gray-500 dark:text-gray-400">{bracket[0]}</span>
        {collapsed && (
          <span className="text-gray-400 dark:text-gray-500 text-xs ml-1">{preview}</span>
        )}
        {collapsed && <span className="text-gray-500 dark:text-gray-400 ml-1">{bracket[1]}</span>}
      </div>
      {!collapsed && (
        <div className="ml-4 border-l border-gray-200 dark:border-gray-700 pl-2">
          {entries.map(([k, v]) => (
            <div key={k}>
              <JsonNode data={v} depth={depth + 1} label={isArray ? null : k} />
              {isArray || <span className="text-gray-400 dark:text-gray-500">,</span>}
            </div>
          ))}
        </div>
      )}
      {!collapsed && <div className="text-gray-500 dark:text-gray-400">{bracket[1]}</div>}
    </div>
  );
}

function Value({ value }) {
  if (value === null) return <span className="text-purple-600 dark:text-purple-400">null</span>;
  if (typeof value === 'boolean')
    return <span className="text-orange-600 dark:text-orange-400">{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="text-green-600 dark:text-green-400">{value}</span>;
  if (typeof value === 'string')
    return <span className="text-red-600 dark:text-red-400">{JSON.stringify(value)}</span>;
  return <span className="text-gray-600 dark:text-gray-400">{String(value)}</span>;
}

export default function JsonViewer({ data }) {
  return (
    <div className="text-xs bg-gray-50 dark:bg-gray-900 border dark:border-gray-700 rounded p-3 overflow-auto max-h-96 font-mono dark:text-gray-200">
      <JsonNode data={data} />
    </div>
  );
}
