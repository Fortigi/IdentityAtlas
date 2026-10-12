// The score of a statement: its confidence pill (coloured by band), whether
// the organisation's data confirms or contradicts it — with what it found —
// and the parts the confidence is made of.
// Props: { claim: { confidence, band, corroboration, confidenceParts } }
import { pillColorClass } from '@ui/components/orgtruth/orgFormat';
import { bandColor, bandOf, confidencePartsText, corroborationPill } from './knowledgeFormat';

const QUIET = 'text-xs text-gray-600 dark:text-gray-400';

export default function StatementScore({ claim }) {
  const hasConfidence = typeof claim.confidence === 'number';
  const verdict = corroborationPill(claim.corroboration);
  const parts = confidencePartsText(claim.confidenceParts);
  if (!hasConfidence && !verdict && !parts) return null;
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1">
        {hasConfidence && (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pillColorClass(bandColor(bandOf(claim)))}`} title="Confidence">{claim.confidence}%</span>
        )}
        {verdict && (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pillColorClass(verdict.color)}`} title={verdict.detail}>{verdict.text}</span>
        )}
        {verdict?.detail && <span className={QUIET}>{verdict.detail}</span>}
      </div>
      {parts && <div className={QUIET}>{parts}</div>}
    </div>
  );
}
