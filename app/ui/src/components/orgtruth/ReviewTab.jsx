// Organisation → Review (workstream T6).
//
// The queue of proposed links and claims (GET /api/org-truth/review): per row
// the org entity, the proposed system object(s) with confidence and matched
// signals, and Confirm / Reject / Move (PUT /api/org-truth/links/:id/override).
// Low confidence first. Reuses ConfidenceBar and the LinkedAccountsPanel idiom.
//
// Props: { onOpenDetail, refreshKey }
import NotBuiltYet from './NotBuiltYet';

export default function ReviewTab() {
  return <NotBuiltYet what="Review" workstream="T6" />;
}
