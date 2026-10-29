import { useMemo, useState } from 'react';
import { formatDate, formatDateOnly } from '@ui/utils/formatters';
import useEntityDiff from '@ui/hooks/useEntityDiff';
import SnapshotDiffView from './SnapshotDiffView';
import {
  DIFF_PRESETS, daysAgoIso, dateInputToIso, isoToDateInput, diffSnapshots, onlyChanges,
} from './entityDiff.helpers';

// ─── EntityDiff ────────────────────────────────────────────────────────
// The entity-detail Diff tab: pick a moment in the past, see the entity as it
// was then (left) next to how it is now (right) — every attribute and every
// relationship, with what changed highlighted.

const DEFAULT_DAYS = 30;

const pill = active => `px-2 py-0.5 rounded text-xs font-medium transition-colors ${
  active
    ? 'bg-blue-600 text-white dark:bg-blue-700'
    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
}`;

function MomentPicker({ at, preset, onPreset, onDate }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1" role="group" aria-label="Compare with">
        {DIFF_PRESETS.map(p => (
          <button key={p.days} type="button" aria-pressed={preset === p.days}
            onClick={() => onPreset(p.days)} className={pill(preset === p.days)}>
            {p.label} ago
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        or date
        <input type="date" value={isoToDateInput(at)} max={isoToDateInput(new Date().toISOString())}
          onChange={e => onDate(e.target.value)}
          className="px-1.5 py-0.5 rounded border border-gray-200 bg-white text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
      </label>
    </div>
  );
}

function Summary({ counts }) {
  const chip = (n, label, cls) => (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{n} {label}</span>
  );
  return (
    <div className="flex flex-wrap gap-2" aria-label="Summary of differences">
      {chip(counts.changed, 'changed', 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300')}
      {chip(counts.added, 'added', 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300')}
      {chip(counts.removed, 'removed', 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300')}
      {chip(counts.unchanged, 'unchanged', 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300')}
    </div>
  );
}

// Notes about what the comparison can and can't show.
function Notes({ data }) {
  const notes = [];
  if (data.historySince && new Date(data.at) < new Date(data.historySince)) {
    notes.push(`Change history starts on ${formatDateOnly(data.historySince)}. Changes before then aren't recorded, so the left side can't go further back than that date.`);
  }
  if (!data.before.exists) notes.push(`This did not exist yet on ${formatDate(data.at)}.`);
  if (data.before.deleted) notes.push(`On ${formatDate(data.at)} this was deleted in the source.`);
  if (data.after.deleted) notes.push('This is now deleted in the source.');
  if (data.omittedUnchanged > 0) {
    notes.push(`${data.omittedUnchanged.toLocaleString()} unchanged relationships are not listed — too many to show. All changes are listed.`);
  }
  if (data.relationshipsTracked === false) {
    notes.push('Membership changes are not recorded for this kind of item, so only its attributes are compared.');
  }
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
      {notes.map(n => <li key={n}>{n}</li>)}
    </ul>
  );
}

export default function EntityDiff({ entityKind, entityId, authFetch, onOpenDetail }) {
  const [at, setAt] = useState(() => daysAgoIso(DEFAULT_DAYS));
  const [preset, setPreset] = useState(DEFAULT_DAYS);
  const [changesOnly, setChangesOnly] = useState(false);
  const { data, loading, error } = useEntityDiff(entityKind, entityId, authFetch, { at });

  const diff = useMemo(() => (data?.before && data?.after ? diffSnapshots(data.before, data.after) : null), [data]);
  const shown = diff && changesOnly ? onlyChanges(diff) : diff;

  const pickPreset = days => { setPreset(days); setAt(daysAgoIso(days)); };
  const pickDate = value => {
    const iso = dateInputToIso(value);
    if (iso && new Date(iso) <= new Date()) { setPreset(null); setAt(iso); }
  };

  const beforeLabel = `As of ${formatDate(at)}`;

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Compare with an earlier moment</h3>
          <MomentPicker at={at} preset={preset} onPreset={pickPreset} onDate={pickDate} />
        </div>
        {diff && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Summary counts={diff.counts} />
            <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={changesOnly} onChange={e => setChangesOnly(e.target.checked)} />
              Only show differences
            </label>
          </div>
        )}
      </div>

      {loading && !diff && (
        <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading comparison…</div>
      )}
      {error && !loading && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Could not load the comparison ({error.message}).
        </div>
      )}
      {data?.before && shown && (
        <div className={loading ? 'opacity-60 transition-opacity' : ''} aria-busy={loading}>
          <Notes data={data} />
          <div className="mt-3">
            <SnapshotDiffView diff={shown} beforeLabel={beforeLabel} afterLabel="Now" onOpenDetail={onOpenDetail} />
          </div>
        </div>
      )}
    </div>
  );
}
