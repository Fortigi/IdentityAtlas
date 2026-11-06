import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useEntitySnapshots from '@ui/hooks/useEntitySnapshots';
import PeoplePicker from '@ui/components/inputs/PeoplePicker';
import EntityCompareView from './EntityCompareView';
import { NoteList } from '@ui/components/SnapshotDiffView';
import {
  MAX_COMPARE, parseCompareIds, compareRouteId, compareSnapshots, visibleComparison,
  toAccount, snapshotName, compareTabLabel,
} from './entityCompare.helpers';

// ─── EntityComparePage ─────────────────────────────────────────────────
// The #compare:<id>,<id>[,<id>] tab: two or three users side by side, showing
// where their access and attributes differ. The ids live in the tab's address,
// so a comparison can be bookmarked or shared; adding or removing a user
// replaces the tab's address (onReplaceRoute).

const ENTITY_KIND = 'user';

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

function Summary({ counts }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Summary of the comparison">
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        {counts.differs} differ
      </span>
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
        {counts.same} the same
      </span>
    </div>
  );
}

// Notes on what the comparison can't show.
function Notes({ entries }) {
  const notes = [];
  for (const e of entries) {
    if (e.error) notes.push(`${e.id} could not be loaded (${e.error.message}).`);
    else if (e.data?.omitted > 0) notes.push(`${snapshotName(e)} has ${e.data.omitted.toLocaleString()} more relationships than can be shown, so the comparison of those is incomplete.`);
    else if (e.data?.snapshot?.deleted) notes.push(`${snapshotName(e)} is deleted in the source.`);
  }
  return <NoteList notes={notes} />;
}

// Picker value for the ids in the address: names from the loaded snapshots.
function pickerValue(ids, entries) {
  const byId = new Map(entries.map(e => [e.id, e]));
  return ids.map(id => ({ principalId: id, userKey: id, displayName: byId.has(id) ? snapshotName(byId.get(id)) : id }));
}

export default function EntityComparePage({ compareId, onOpenDetail, onReplaceRoute, onCacheData }) {
  const { authFetch } = useAuth();
  const ids = useMemo(() => parseCompareIds(compareId), [compareId]);
  const { entries, loading } = useEntitySnapshots(ENTITY_KIND, ids, authFetch);
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const [hidePersonal, setHidePersonal] = useState(true);

  const loaded = useMemo(() => entries.filter(e => e.data?.snapshot), [entries]);
  // Fewer than two picked: nothing to compare, even if an earlier pair is still loaded.
  const comparison = useMemo(
    () => (ids.length >= 2 && loaded.length >= 2 ? compareSnapshots(loaded.map(e => e.data.snapshot)) : null),
    [ids.length, loaded],
  );
  const shown = comparison && visibleComparison(comparison, { onlyDifferences, hidePersonal });

  // Name the tab after the users once this id set has loaded (not the previous set's).
  const tabLabel = loading || loaded.length === 0 ? null : compareTabLabel(loaded);
  useEffect(() => {
    if (tabLabel) onCacheData?.(compareId, 'compare', { displayName: tabLabel });
  }, [compareId, tabLabel, onCacheData]);

  const onPick = (people) => onReplaceRoute?.(compareRouteId(people.map(p => p.userKey)));

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Compare users</h2>
        <PeoplePicker
          value={pickerValue(ids, entries)}
          onChange={onPick}
          toItem={toAccount}
          max={MAX_COMPARE}
          inputId="compare-picker"
          label={`Users to compare (2 or ${MAX_COMPARE})`}
          help="Search by name or UPN and pick the users you want to see side by side."
        />
        {comparison && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Summary counts={comparison.counts} />
            <div className="flex flex-wrap items-center gap-4">
              <Toggle checked={onlyDifferences} onChange={setOnlyDifferences}>Only show differences</Toggle>
              <Toggle checked={hidePersonal} onChange={setHidePersonal}>Hide names, e-mail and IDs</Toggle>
            </div>
          </div>
        )}
      </div>

      {ids.length < 2 && (
        <p className="p-6 text-center text-sm text-gray-600 dark:text-gray-400">
          Pick {ids.length === 0 ? 'two or three users' : 'one or two more users'} to compare.
        </p>
      )}
      {ids.length >= 2 && loading && !comparison && (
        <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading comparison…</div>
      )}
      {ids.length >= 2 && !loading && <Notes entries={entries} />}
      {shown && (
        <div className={loading ? 'opacity-60 transition-opacity' : ''} aria-busy={loading}>
          <EntityCompareView comparison={shown} names={loaded.map(snapshotName)} onOpenDetail={onOpenDetail} />
        </div>
      )}
    </div>
  );
}
