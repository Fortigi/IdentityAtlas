// "Accept all N" / "Reject all N" over a list of statements (only the proposed
// ones count and are sent). Renders nothing when none is proposed.
// Props: { claims, scope, label?, busy, onBulk(status, claims, scope) }
import { SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { proposedIds } from './knowledgeFormat';

export default function BulkButtons({ claims, scope, label, busy, onBulk }) {
  const n = proposedIds(claims).length;
  if (n === 0) return null;
  const words = label ?? `all ${n}`;
  return (
    <span className="inline-flex gap-2">
      <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => onBulk('accepted', claims, scope)}>Accept {words}</button>
      <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => onBulk('rejected', claims, scope)}>Reject {words}</button>
    </span>
  );
}
