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

// Attributes whose changes mean nothing to a reader of the timeline.
const TIMELINE_HIDDEN_FIELDS = ['lastCalculatedAt', 'SysStartTime', 'SysEndTime'];

export function TimelineSection({ contextId, authFetch, onOpenDetail }) {
  const [open, setOpen] = useState(false);
  const [sinceDays, setSinceDays] = useState(90);
  const timeline = useTimeline('context', contextId, authFetch, { sinceDays, enabled: open });
  return (
    <FoldSection title="Timeline" testId="timeline" summary="What changed, and who decided what" open={open} onOpenChange={setOpen}>
      <EntityTimeline events={timeline.events} loading={timeline.loading} sinceDays={sinceDays} onSinceDaysChange={setSinceDays}
        onOpenDetail={onOpenDetail} hideFields={TIMELINE_HIDDEN_FIELDS} />
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
