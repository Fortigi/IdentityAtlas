import FoldSection from '@ui/components/contexts/FoldSection';
import { useContextClaims } from './claimsContext';
import SourcesList from './SourcesList';
import AddInformation from './AddInformation';
import { sourcesSummary } from './claims.helpers';

// ─── Sources — everything added about this context (analysts only) ───────
// Folded to one line: how many, and the latest date. "Add information" sits on
// that line. Open: the Sources list (SourcesList.jsx). The records are the
// ClaimsProvider's (GET …/interviews, served with data.write.contexts only).

export default function SourcesSection({ id, contextId, open, onOpenChange }) {
  const ctx = useContextClaims();
  if (!ctx?.canWrite) return null;
  return (
    <FoldSection id={id} title="Sources" testId="sources" summary={sourcesSummary(ctx.interviews)} open={open} onOpenChange={onOpenChange}
      actions={<AddInformation contextId={contextId} />}>
      <SourcesList contextId={contextId} interviews={ctx.interviews} onChanged={ctx.reload} onViewTranscript={ctx.openTranscript} />
    </FoldSection>
  );
}
