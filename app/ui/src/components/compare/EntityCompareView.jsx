import { formatValue } from '@ui/utils/formatters';
import { ItemCell } from '@ui/components/SnapshotDiffView';
import { isEmpty } from '@ui/components/entityDiff.helpers';

// ─── EntityCompareView ─────────────────────────────────────────────────
// Two or three entities side by side, one column each, aligned row by row:
// every attribute and every relationship any of them has. A row where they
// are not all the same is marked; a cell where an entity lacks the item is
// greyed with a dash. Takes the output of compareSnapshots()
// (entityCompare.helpers.js) after visibleComparison().

const DIFFERS = 'bg-amber-50 text-amber-900 dark:bg-amber-900/25 dark:text-amber-100';
const MISSING = 'bg-gray-50 text-gray-600 dark:bg-gray-900/40 dark:text-gray-400';
const PLAIN = 'text-gray-900 dark:text-gray-100';
const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden';
const HEADING = 'px-3 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700';

// Grid template: a label column (attributes only) plus one column per entity.
function gridStyle(columns, withLabel) {
  const cols = `repeat(${columns}, minmax(0, 1fr))`;
  return { gridTemplateColumns: withLabel ? `minmax(7rem, 13rem) ${cols}` : cols };
}

function cellClass(status, present) {
  if (!present) return MISSING;
  return status === 'differs' ? DIFFERS : PLAIN;
}

function StatusText({ status }) {
  return <span className="sr-only"> — {status === 'differs' ? 'differs' : 'same'}</span>;
}

function ColumnHeader({ names, first }) {
  return (
    <div className="grid text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700"
      style={gridStyle(names.length, first !== undefined)}>
      {first !== undefined && <div className="px-3 py-2">{first}</div>}
      {names.map((n, i) => (
        <div key={i} className={`px-3 py-2 truncate ${i > 0 || first !== undefined ? 'border-l border-gray-200 dark:border-gray-700' : ''}`}>{n}</div>
      ))}
    </div>
  );
}

function AttributeRow({ row }) {
  return (
    <li className="grid text-sm" style={gridStyle(row.values.length, true)} data-status={row.status}>
      <div className="px-3 py-1.5 text-gray-700 dark:text-gray-300 font-medium break-words" title={row.key}>
        {row.label}
        {row.extended && <span className="ml-1 text-[10px] font-normal text-gray-600 dark:text-gray-400">(extended)</span>}
        <StatusText status={row.status} />
      </div>
      {row.values.map((v, i) => {
        const present = !isEmpty(v);
        return (
          <div key={i} className={`px-3 py-1.5 border-l border-gray-100 dark:border-gray-700 ${cellClass(row.status, present)}`}>
            <span className="whitespace-pre-wrap break-all">{present ? formatValue(v) : '—'}</span>
          </div>
        );
      })}
    </li>
  );
}

export function AttributeCompareTable({ rows, names }) {
  return (
    <section className={CARD}>
      <h4 className={HEADING}>Attributes</h4>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm italic text-gray-600 dark:text-gray-400">No attribute differences.</p>
      ) : (
        <>
          <ColumnHeader names={names} first="Attribute" />
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map(r => <AttributeRow key={r.key} row={r} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function GroupCounts({ counts }) {
  return (
    <span className="text-xs font-normal text-gray-600 dark:text-gray-400 tabular-nums" aria-label="Count per column">
      {counts.join(' · ')}
    </span>
  );
}

export function RelationshipCompareGroups({ groups, names, onOpenDetail }) {
  if (groups.length === 0) {
    return (
      <section className={CARD}>
        <h4 className={HEADING}>Access and relationships</h4>
        <p className="px-3 py-3 text-sm italic text-gray-600 dark:text-gray-400">No differences in access or relationships.</p>
      </section>
    );
  }
  return groups.map(g => (
    <section key={g.group} className={CARD}>
      <h4 className={`flex items-center justify-between gap-2 ${HEADING}`}>
        <span>{g.group}</span>
        <GroupCounts counts={g.counts} />
      </h4>
      <ColumnHeader names={names} />
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {g.rows.map(r => (
          <li key={r.key} className="grid text-sm" style={gridStyle(r.items.length, false)} data-status={r.status}>
            {r.items.map((item, i) => (
              <div key={i} className={`px-3 py-1.5 ${i > 0 ? 'border-l border-gray-100 dark:border-gray-700' : ''} ${cellClass(r.status, !!item)}`}>
                {item ? <ItemCell item={item} onOpenDetail={onOpenDetail} /> : <span aria-label="not held">—</span>}
                {i === 0 && <StatusText status={r.status} />}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  ));
}

export default function EntityCompareView({ comparison, names, onOpenDetail }) {
  return (
    <div className="space-y-4">
      <RelationshipCompareGroups groups={comparison.groups} names={names} onOpenDetail={onOpenDetail} />
      <AttributeCompareTable rows={comparison.attributes} names={names} />
    </div>
  );
}
