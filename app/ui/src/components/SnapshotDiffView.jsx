import { formatValue } from '@ui/utils/formatters';
import { KIND_TO_TAB } from './RecentChangesSection.helpers.jsx';

// ─── SnapshotDiffView ──────────────────────────────────────────────────
// Side-by-side compare of two entity snapshots, like a two-file diff: the left
// column is one state, the right column the other, aligned row by row. Removed
// or old values are tinted red on the left, added or new values green on the
// right. Takes the output of diffSnapshots() (entityDiff.helpers.js); it does
// not know where the snapshots came from, so it can also show a proposed state.

const LEFT_TINT = {
  removed: 'bg-red-50 text-red-800 dark:bg-red-900/25 dark:text-red-200',
  changed: 'bg-red-50 text-red-800 dark:bg-red-900/25 dark:text-red-200',
};
const RIGHT_TINT = {
  added: 'bg-green-50 text-green-800 dark:bg-green-900/25 dark:text-green-200',
  changed: 'bg-green-50 text-green-800 dark:bg-green-900/25 dark:text-green-200',
};
const EMPTY_SIDE = 'bg-gray-50 dark:bg-gray-900/40';
const PLAIN = 'text-gray-900 dark:text-gray-100';

const MARK = { removed: '−', added: '+', changed: '~' };

function Marker({ status, side }) {
  const show = (side === 'left' && (status === 'removed' || status === 'changed'))
    || (side === 'right' && (status === 'added' || status === 'changed'));
  return (
    <span className="w-3 shrink-0 select-none text-center font-mono text-xs opacity-80" aria-hidden="true">
      {show ? (status === 'changed' ? MARK.changed : side === 'left' ? MARK.removed : MARK.added) : ''}
    </span>
  );
}

function cellClass(status, side, present) {
  if (!present) return EMPTY_SIDE;
  const tint = side === 'left' ? LEFT_TINT[status] : RIGHT_TINT[status];
  return tint || PLAIN;
}

const STATUS_TEXT = { added: 'added', removed: 'removed', changed: 'changed', unchanged: 'unchanged' };

function ColumnHeader({ beforeLabel, afterLabel, first = 'Attribute' }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,13rem)_1fr_1fr] text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
      <div className="px-3 py-2">{first}</div>
      <div className="px-3 py-2 border-l border-gray-200 dark:border-gray-700">{beforeLabel}</div>
      <div className="px-3 py-2 border-l border-gray-200 dark:border-gray-700">{afterLabel}</div>
    </div>
  );
}

export function AttributeDiffTable({ rows, beforeLabel, afterLabel }) {
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <h4 className="px-3 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700">Attributes</h4>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm italic text-gray-600 dark:text-gray-400">No attribute changes.</p>
      ) : (
        <>
          <ColumnHeader beforeLabel={beforeLabel} afterLabel={afterLabel} />
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map(r => {
              const hasBefore = r.status !== 'added';
              const hasAfter = r.status !== 'removed';
              return (
                <li key={r.key} className="grid grid-cols-[minmax(7rem,13rem)_1fr_1fr] text-sm" data-status={r.status}>
                  <div className="px-3 py-1.5 text-gray-700 dark:text-gray-300 font-medium break-words" title={r.key}>
                    {r.label}
                    {r.extended && <span className="ml-1 text-[10px] font-normal text-gray-600 dark:text-gray-400">(extended)</span>}
                    <span className="sr-only"> — {STATUS_TEXT[r.status]}</span>
                  </div>
                  <div className={`flex gap-1 px-2 py-1.5 border-l border-gray-100 dark:border-gray-700 ${cellClass(r.status, 'left', hasBefore)}`}>
                    <Marker status={r.status} side="left" />
                    {hasBefore && <span className="whitespace-pre-wrap break-all">{formatValue(r.before)}</span>}
                  </div>
                  <div className={`flex gap-1 px-2 py-1.5 border-l border-gray-100 dark:border-gray-700 ${cellClass(r.status, 'right', hasAfter)}`}>
                    <Marker status={r.status} side="right" />
                    {hasAfter && <span className="whitespace-pre-wrap break-all">{formatValue(r.after)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ItemCell({ item, onOpenDetail }) {
  const target = KIND_TO_TAB[item.kind];
  const linkable = target && item.id && onOpenDetail;
  return (
    <span className="min-w-0">
      {linkable ? (
        <button type="button" onClick={() => onOpenDetail(target, item.id, item.label)}
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid text-left break-words">
          {item.label}
        </button>
      ) : (
        <span className="break-words">{item.label}</span>
      )}
      {item.detail && <span className="ml-2 text-xs opacity-80">{item.detail}</span>}
    </span>
  );
}

function GroupCounts({ group }) {
  const added = group.rows.filter(r => r.status === 'added').length;
  const removed = group.rows.filter(r => r.status === 'removed').length;
  return (
    <span className="flex items-center gap-2 text-xs font-normal">
      <span className="text-gray-600 dark:text-gray-400 tabular-nums">{group.beforeCount} → {group.afterCount}</span>
      {added > 0 && <span className="px-1.5 rounded bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300">+{added}</span>}
      {removed > 0 && <span className="px-1.5 rounded bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">−{removed}</span>}
    </span>
  );
}

export function RelationshipDiffGroups({ groups, beforeLabel, afterLabel, onOpenDetail }) {
  if (groups.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
        <h4 className="px-3 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700">Relationships</h4>
        <p className="px-3 py-3 text-sm italic text-gray-600 dark:text-gray-400">No relationship changes.</p>
      </section>
    );
  }
  return groups.map(g => (
    <section key={g.group} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <h4 className="flex items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700">
        <span>{g.group}</span>
        <GroupCounts group={g} />
      </h4>
      <div className="grid grid-cols-2 text-xs font-semibold text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
        <div className="px-3 py-1.5">{beforeLabel}</div>
        <div className="px-3 py-1.5 border-l border-gray-200 dark:border-gray-700">{afterLabel}</div>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {g.rows.map(r => (
          <li key={r.key} className="grid grid-cols-2 text-sm" data-status={r.status}>
            <div className={`flex gap-1 px-2 py-1.5 ${cellClass(r.status, 'left', !!r.before)}`}>
              <Marker status={r.status} side="left" />
              {r.before && <ItemCell item={r.before} onOpenDetail={onOpenDetail} />}
            </div>
            <div className={`flex gap-1 px-2 py-1.5 border-l border-gray-100 dark:border-gray-700 ${cellClass(r.status, 'right', !!r.after)}`}>
              <Marker status={r.status} side="right" />
              {r.after && <ItemCell item={r.after} onOpenDetail={onOpenDetail} />}
              <span className="sr-only"> — {STATUS_TEXT[r.status]}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  ));
}

export default function SnapshotDiffView({ diff, beforeLabel, afterLabel, onOpenDetail }) {
  return (
    <div className="space-y-4">
      <AttributeDiffTable rows={diff.attributes} beforeLabel={beforeLabel} afterLabel={afterLabel} />
      <RelationshipDiffGroups groups={diff.groups} beforeLabel={beforeLabel} afterLabel={afterLabel} onOpenDetail={onOpenDetail} />
    </div>
  );
}
