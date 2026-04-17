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
        {label && <span className="text-blue-600">{JSON.stringify(label)}: </span>}
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
        className="cursor-pointer hover:bg-gray-100 rounded px-1 -mx-1 inline-block select-none"
      >
        <span className="text-gray-400 mr-1">{collapsed ? '▶' : '▼'}</span>
        {label && <span className="text-blue-600">{JSON.stringify(label)}: </span>}
        <span className="text-gray-500">{bracket[0]}</span>
        {collapsed && (
          <span className="text-gray-400 text-xs ml-1">{preview}</span>
        )}
        {collapsed && <span className="text-gray-500 ml-1">{bracket[1]}</span>}
      </div>
      {!collapsed && (
        <div className="ml-4 border-l border-gray-200 pl-2">
          {entries.map(([k, v]) => (
            <div key={k}>
              <JsonNode data={v} depth={depth + 1} label={isArray ? null : k} />
              {isArray || <span className="text-gray-400">,</span>}
            </div>
          ))}
        </div>
      )}
      {!collapsed && <div className="text-gray-500">{bracket[1]}</div>}
    </div>
  );
}

function Value({ value }) {
  if (value === null) return <span className="text-purple-600">null</span>;
  if (typeof value === 'boolean')
    return <span className="text-orange-600">{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="text-green-600">{value}</span>;
  if (typeof value === 'string')
    return <span className="text-red-600">{JSON.stringify(value)}</span>;
  return <span className="text-gray-600">{String(value)}</span>;
}

export default function JsonViewer({ data }) {
  return (
    <div className="text-xs bg-gray-50 border rounded p-3 overflow-auto max-h-96 font-mono">
      <JsonNode data={data} />
    </div>
  );
}
