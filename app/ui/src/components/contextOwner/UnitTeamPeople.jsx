// The people part of an organizational unit, the same for every reader (an owner,
// an analyst, an admin): the team overview first, the full People list folded
// under it. `open` / `onOpenChange`: the page opens the fold when its attention
// line points into it. If the overview cannot be loaded the reader simply gets the
// People list, so a failure never leaves them without the team.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import FoldSection from '@ui/components/contexts/FoldSection';
import TeamOverview from './TeamOverview';

export default function UnitTeamPeople({ contextId, onOpenDetail, open, onOpenChange, children }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/contexts/${encodeURIComponent(contextId)}/team-overview`, { authFetch });
  if (loading) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading your team…</p>;
  if (error || !Array.isArray(data?.people)) return children;
  return (
    <>
      <TeamOverview contextId={contextId} overview={data} onOpenDetail={onOpenDetail} />
      <FoldSection title="People details" summary="Status, source and access per person" testId="people-details" open={open} onOpenChange={onOpenChange}>
        {children}
      </FoldSection>
    </>
  );
}
