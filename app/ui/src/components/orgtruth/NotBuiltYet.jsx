// Placeholder a workstream replaces with the real panel. Kept as one shared
// component so the stubs stay identical and jscpd has nothing to flag.
import EmptyState from '@ui/components/EmptyState';

export default function NotBuiltYet({ what, workstream }) {
  return (
    <EmptyState
      title={`${what} — not built yet`}
      hint={`This panel is workstream ${workstream} of the organisation-truth MVP. See the handover for its contract.`}
    />
  );
}
