// Compact "Activity" summary on a user or identity page: per activity list
// (timesheets, logs), the subjects this person has activity on, with the
// total, the last activity and whether they are a member of it.
//
// GET /api/org-truth/activity/actor/:targetType/:id (an identity and its
// accounts are merged server-side; shape in activity.js). Only with the
// orgTruth feature on; a missing route, a failure or no activity renders
// nothing.
//
// Props: { targetType: 'Principal' | 'Identity', id, onOpenDetail }
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';
import { Section } from '@ui/components/DetailSection';
import { actorGroups, formatMeasure, formatOn, refDetailKind } from './activity';
import { TH, TD, LINK_BUTTON } from './orgUi';

function SubjectCell({ subject, onOpenDetail }) {
  const kind = refDetailKind(subject.targetType);
  if (!kind || !subject.targetId) return <span>{subject.label}</span>;
  return <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(kind, subject.targetId, subject.label)}>{subject.label}</button>;
}

function GroupTable({ group, onOpenDetail }) {
  return (
    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700" aria-label={group.type}>
      <caption className="text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400 mb-1">{group.type}</caption>
      <thead><tr>{['On', 'Total', 'Last activity', 'Member'].map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {group.subjects.map(s => (
          <tr key={`${s.targetType}:${s.targetId}`}>
            <td className={TD}><SubjectCell subject={s} onOpenDetail={onOpenDetail} /></td>
            <td className={TD}>{formatMeasure(s.total, group.unit)}</td>
            <td className={TD}>{formatOn(s.lastOn) || '—'}</td>
            <td className={`${TD} ${s.isMember ? '' : 'text-amber-700 dark:text-amber-300'}`}>{s.isMember ? 'yes' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OrgActivitySummary({ targetType, id, onOpenDetail }) {
  const { authFetch } = useAuth();
  const enabled = useFeatureFlags().orgTruth === true && Boolean(id);
  const url = `/api/org-truth/activity/actor/${encodeURIComponent(targetType)}/${encodeURIComponent(id)}`;
  const { data, error } = useFetch(enabled ? url : null, { authFetch, enabled });
  const groups = enabled && !error ? actorGroups(data) : [];
  if (groups.length === 0) return null;
  return (
    <Section title="Activity in imported lists">
      <div className="space-y-4">
        {groups.map(g => <GroupTable key={g.type} group={g} onOpenDetail={onOpenDetail} />)}
      </div>
    </Section>
  );
}
