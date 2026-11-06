import { useState } from 'react';
import useTimeline from '@ui/hooks/useTimeline';
import EntityTimeline from '@ui/components/EntityTimeline';
import EntityDiff from '@ui/components/EntityDiff';
import RiskScoreSection from '@ui/components/RiskScoreSection';
import FoldSection from '@ui/components/contexts/FoldSection';

// The sections every context page ends with, for the analyst: the Timeline
// (what changed, read only once it is opened), the Diff (the context compared
// with an earlier moment, read only once opened) and the Risk score (when the
// feature is on and the context has one). All start folded.

// The unit's timeline says what happened in words (people joined and left,
// roles, the tree, the members' own changes, what the sources decided), with a
// People / Roles / Structure / Knowledge filter and bursts folded.
export function TimelineSection({ contextId, authFetch, onOpenDetail }) {
  const [open, setOpen] = useState(false);
  const [sinceDays, setSinceDays] = useState(90);
  const timeline = useTimeline('context', contextId, authFetch, { sinceDays, enabled: open });
  return (
    <FoldSection title="Timeline" testId="timeline" summary="Who joined and left, roles, the tree, and who decided what" open={open} onOpenChange={setOpen}>
      <EntityTimeline events={timeline.events} loading={timeline.loading} sinceDays={sinceDays} onSinceDaysChange={setSinceDays}
        onOpenDetail={onOpenDetail} />
    </FoldSection>
  );
}

// FoldSection renders its body only while open, so the diff is fetched on opening.
export function DiffSection({ contextId, authFetch, onOpenDetail }) {
  return (
    <FoldSection title="Diff" testId="diff" summary="Compare with an earlier moment">
      <EntityDiff entityKind="context" entityId={contextId} authFetch={authFetch} onOpenDetail={onOpenDetail} />
    </FoldSection>
  );
}

export function RiskSection({ contextId, riskData, authFetch }) {
  if (!riskData) return null;
  return (
    <FoldSection title="Risk" testId="risk" summary={riskData.riskTier ? `${riskData.riskTier} · ${riskData.riskScore}` : String(riskData.riskScore)}>
      <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />
    </FoldSection>
  );
}
