import { useState } from 'react';
import useTimeline from '@ui/hooks/useTimeline';
import EntityTimeline from '@ui/components/EntityTimeline';
import RiskScoreSection from '@ui/components/RiskScoreSection';
import FoldSection from '@ui/components/contexts/FoldSection';

// The two sections every context page ends with, for the analyst: the Timeline
// (what changed, read only once it is opened) and the Risk score (when the
// feature is on and the context has one). Both start folded.

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

export function RiskSection({ contextId, riskData, authFetch }) {
  if (!riskData) return null;
  return (
    <FoldSection title="Risk" testId="risk" summary={riskData.riskTier ? `${riskData.riskTier} · ${riskData.riskScore}` : String(riskData.riskScore)}>
      <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />
    </FoldSection>
  );
}
