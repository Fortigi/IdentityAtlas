import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useHasPermission } from '@ui/auth/usePermissions';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { useDialog } from '@ui/components/dialogContext';
import { readJson } from '@ui/components/contexts/upload/useContextUpload';
import Select from '@ui/components/inputs/Select';
import ActivityGroups from './ActivityGroups';
import ActivityChildrenTable from './ActivityChildrenTable';
import ActivityUploads from './ActivityUploads';
import { useContextActivity } from './useContextActivity';
import { useActivityVersion, notifyActivityChanged } from './activityEvents';
import { PERIOD_OPTIONS, periodFor, sectionShape } from './activity.helpers';

// The Activity section of a unit's or application's page: who was active on it
// in a period — compared with its current members — and, on a parent, a table
// of its sub-units by month. Shown only when there is activity here or below.
// Activity is evidence: nothing here changes the members. Read-only for a
// reader without data.write.contexts (no Undo); absent from a read-only shared
// view (a context owner's page), which cannot read it.

const DEFAULT_PERIOD = '12';

export default function ActivitySection({ attrs, subContexts = [], onOpenDetail }) {
  const sharedView = useIsSharedView();
  if (sharedView) return null;
  return <Activity attrs={attrs} hasChildren={subContexts.length > 0} onOpenDetail={onOpenDetail} />;
}

function Activity({ attrs, hasChildren, onOpenDetail }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const canWrite = useHasPermission('data.write.contexts');
  const version = useActivityVersion(attrs.id);
  const [choice, setChoice] = useState({ value: DEFAULT_PERIOD, latest: null });
  const [busyId, setBusyId] = useState(null);
  const period = choice.value === DEFAULT_PERIOD ? null : periodFor(choice.value, choice.latest);
  const a = useContextActivity(authFetch, attrs.id, { hasChildren, period, version });

  const shape = sectionShape({ own: a.own, summary: a.summary, uploads: a.uploads, chosenLatest: choice.latest });
  if (shape.empty) return null;

  async function undo(u) {
    if (!(await dialog.confirm({ title: 'Undo upload', message: `Remove the ${u.rowsHeld} activity rows of ${u.fileName}? The members do not change.`, confirmLabel: 'Undo upload', danger: true }))) return;
    setBusyId(u.id);
    try {
      await readJson(await authFetch(`/api/contexts/${encodeURIComponent(attrs.id)}/activity/uploads/${encodeURIComponent(u.id)}`, { method: 'DELETE' }));
      notifyActivityChanged(attrs.id);
    } catch (err) {
      dialog.alert(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-label="Activity" className="space-y-4 rounded-lg border border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Activity</h3>
          <p className="text-[11px] text-gray-600 dark:text-gray-400">
            Who worked on this, from uploaded exports — evidence, not membership.{shownPeriod(shape.shown)}
          </p>
        </div>
        <Select id={`activity-period-${attrs.id}`} value={choice.value} aria-label="Period"
          className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          onChange={e => setChoice({ value: e.target.value, latest: shape.latest })}>
          {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>
      {a.error && <p className="text-xs text-red-700 dark:text-red-300">The activity could not be read.</p>}
      {shape.hasPeople && <ActivityGroups view={a.own} onOpenDetail={onOpenDetail} />}
      {shape.childPeriod && <ActivityChildrenTable summary={a.summary} onOpenDetail={onOpenDetail} />}
      <ActivityUploads uploads={a.uploads} contextId={attrs.id} canUndo={canWrite} onUndo={undo} busyId={busyId} />
    </section>
  );
}

const shownPeriod = (p) => (p ? ` ${p.from} – ${p.to}.` : '');
