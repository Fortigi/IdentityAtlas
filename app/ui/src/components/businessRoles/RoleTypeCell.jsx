import WayChips from './WayChips';
import { accessDetail } from './accessModel';

// A business role's type, as one chip (Rule based / Manual / Unknown), with a
// note when people decide who holds it but no review is set up. The tooltip
// lists the ways in and out. Used by the Business Roles list and a unit's team overview.
export default function RoleTypeCell({ accessModel }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={accessDetail(accessModel)} data-testid="role-type">
      <WayChips ways={[accessModel?.control ?? 'Unknown']} direction="control" />
      {accessModel?.reviewGap && <span className="text-xs text-amber-700 dark:text-amber-300">no review set up</span>}
    </span>
  );
}
