import { useState, useMemo } from 'react';
import { useFetch } from '@ui/hooks/useFetch';

// Relationship filter control (#840). Sibling of FilterBar — lets you filter a
// list by the presence / absence / count of a graph edge (e.g. "groups with no
// owners", "guests with no sponsor"). Renders inline elements (Fragment); place
// inside a flex container next to FilterBar.
//
// Props:
//   entity       'Resource' | 'Principal' — the relationship target for this list
//   authFetch    authenticated fetch (from useAuth)
//   relFilters   [{edge, op, n?}] active relationship conditions
//   onAdd(cond)  add/replace a condition
//   onRemove(edgeId)

const OP_LABEL = { exists: 'has value', absent: 'has no value', eq: 'count =', lt: 'count <', gt: 'count >' };
const COUNT_OPS = ['eq', 'lt', 'gt'];

export default function RelationshipFilterBar({ entity, authFetch, relFilters, onAdd, onRemove }) {
  const { data: edges } = useFetch(`/api/relationship-edges?entity=${entity}`, {
    authFetch,
    enabled: !!entity,
    initialData: [],
    transform: (json) => json.edges || [],
  });

  const [adding, setAdding] = useState(false);
  const [edge, setEdge] = useState('');
  const [op, setOp] = useState('absent');
  const [n, setN] = useState('0');

  const edgeById = useMemo(() => Object.fromEntries(edges.map((e) => [e.id, e])), [edges]);
  const activeEdges = useMemo(() => new Set(relFilters.map((f) => f.edge)), [relFilters]);
  // Offer edges not already used. Unavailable edges (no data yet — e.g. an
  // un-run opt-in phase) stay listed but disabled with a hint.
  const selectable = edges.filter((e) => !activeEdges.has(e.id));

  const reset = () => { setAdding(false); setEdge(''); setOp('absent'); setN('0'); };

  const confirm = () => {
    if (!edge) return;
    const cond = { edge, op };
    if (COUNT_OPS.includes(op)) cond.n = Math.max(0, parseInt(n, 10) || 0);
    onAdd(cond);
    reset();
  };

  const describe = (f) => {
    const label = edgeById[f.edge]?.label || f.edge;
    const opText = COUNT_OPS.includes(f.op) ? `${OP_LABEL[f.op]} ${f.n}` : OP_LABEL[f.op];
    return `${label}: ${opText}`;
  };

  return (
    <>
      <span className="font-medium text-gray-700 dark:text-gray-300">Relationships:</span>

      {relFilters.map((f) => (
        <span
          key={f.edge}
          className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 rounded text-xs"
        >
          <span className="font-medium text-indigo-700 dark:text-indigo-300">{describe(f)}</span>
          <button
            onClick={() => onRemove(f.edge)}
            className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 font-bold ml-0.5"
            title="Remove relationship filter"
          >
            &times;
          </button>
        </span>
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-xs">
          <select
            autoFocus
            aria-label="Relationship edge"
            value={edge}
            onChange={(e) => setEdge(e.target.value)}
            className="bg-transparent border-none text-xs dark:text-gray-200 p-0 pr-4"
          >
            <option value="">Select relationship...</option>
            {selectable.map((e) => (
              <option key={e.id} value={e.id} disabled={!e.available}>
                {e.label}{e.available ? '' : ' (no data yet)'}
              </option>
            ))}
          </select>
          {edge && (
            <>
              <select
                aria-label="Relationship operator"
                value={op}
                onChange={(e) => setOp(e.target.value)}
                className="bg-transparent border-none text-xs dark:text-gray-200 p-0 pr-4"
              >
                {Object.entries(OP_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              {COUNT_OPS.includes(op) && (
                <input
                  type="number"
                  min="0"
                  aria-label="Relationship count"
                  value={n}
                  onChange={(e) => setN(e.target.value)}
                  className="w-14 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded text-xs px-1 dark:text-gray-200"
                />
              )}
              <button
                onClick={confirm}
                className="text-indigo-700 dark:text-indigo-300 font-semibold hover:underline"
              >
                Add
              </button>
            </>
          )}
          <button
            onClick={reset}
            className="text-gray-600 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-bold"
          >
            &times;
          </button>
        </span>
      ) : (
        selectable.length > 0 && (
          <button
            onClick={() => setAdding(true)}
            className="px-2 py-1 rounded text-xs text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 border-dashed"
          >
            + Add relationship
          </button>
        )
      )}
    </>
  );
}
