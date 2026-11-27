import WayChips from './WayChips';
import { accessDetail, participantLabel, participantNotes } from './accessModel';

// ─── A business role as it was at one moment ─────────────────────────────
// The snapshot a composition review stored (lib/businessRoleSnapshot.js): the
// type, who held and answered for it, who approved requests and reviewed the
// holders, its policies with their rules, and the resources it contained. Read-only; it never changes after the review.

const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400';
const TEXT = 'text-sm text-gray-800 dark:text-gray-200';

function Part({ label, children }) {
  return (
    <div className="space-y-1">
      <p className={LABEL}>{label}</p>
      {children}
    </div>
  );
}

function Owners({ owners }) {
  if (owners.length === 0) return <p className={TEXT}>Nobody</p>;
  return (
    <ul className={TEXT}>
      {owners.map((o, i) => (
        <li key={`${o.role}-${o.displayName}-${i}`}>
          <span className="font-medium">{o.role}</span>: {o.displayName || 'unnamed'}
          {o.derivedFrom?.length ? <span className="text-xs text-gray-600 dark:text-gray-400"> ({o.derivedFrom.join(' and ').toLowerCase()})</span> : null}
        </li>
      ))}
    </ul>
  );
}

// The people the policies named in one part (Approver, Reviewer); nothing when
// there were none, so a role nobody approves shows no empty heading.
function Participants({ label, people }) {
  if (people.length === 0) return null;
  return (
    <Part label={label}>
      <ul className={TEXT}>
        {people.map((p, i) => {
          const notes = participantNotes(p);
          return (
            <li key={`${p.policyId}-${participantLabel(p)}-${i}`}>
              {participantLabel(p)}
              {notes.length > 0 && <span className="text-xs text-gray-600 dark:text-gray-400"> ({notes.join(', ')})</span>}
            </li>
          );
        })}
      </ul>
    </Part>
  );
}

function Policies({ policies }) {
  if (policies.length === 0) return <p className={TEXT}>None</p>;
  return (
    <ul className="space-y-1.5">
      {policies.map(p => (
        <li key={p.id} className={TEXT}>
          <span className="font-medium">{p.displayName || p.id}</span>{' '}
          <span className="text-xs text-gray-600 dark:text-gray-400">{accessDetail(p)}</span>
          {p.targetRule && <code className="mt-0.5 block break-all rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{p.targetRule}</code>}
        </li>
      ))}
    </ul>
  );
}

function Resources({ resources }) {
  if (resources.length === 0) return <p className={TEXT}>None</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
          <th scope="col" className="py-1 pr-3 font-medium">Name</th>
          <th scope="col" className="py-1 pr-3 font-medium">Type</th>
          <th scope="col" className="py-1 font-medium">System</th>
        </tr>
      </thead>
      <tbody>
        {resources.map(r => (
          <tr key={r.id} className="border-t border-gray-100 text-gray-800 dark:border-gray-700 dark:text-gray-200">
            <td className="py-1 pr-3">{r.displayName}</td>
            <td className="py-1 pr-3">{r.resourceType || '—'}</td>
            <td className="py-1">{r.systemName || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RoleSnapshot({ snapshot }) {
  if (!snapshot?.type) return <p className={TEXT}>No snapshot was kept for this review.</p>;
  const { role = {}, type, policies = [], owners = [], resources = [], participants = [] } = snapshot;
  const inPart = (part) => participants.filter(p => p.participation === part);
  return (
    <div className="space-y-3" data-testid="role-snapshot">
      <Part label="Type">
        <p className={`${TEXT} flex flex-wrap items-center gap-2`}>
          <WayChips ways={[type.control]} direction="control" />
          <span className="text-xs text-gray-600 dark:text-gray-400">{accessDetail(type)}</span>
        </p>
      </Part>
      <Part label="Held by"><p className={TEXT}>{role.holderCount === 1 ? '1 person' : `${role.holderCount ?? 0} people`}</p></Part>
      <Part label="Who answered for it"><Owners owners={owners} /></Part>
      <Participants label="Who approved a request" people={inPart('Approver')} />
      <Participants label="Who reviewed the holders" people={inPart('Reviewer')} />
      <Part label={`Policies (${policies.length})`}><Policies policies={policies} /></Part>
      <Part label={`Resources (${resources.length})`}><Resources resources={resources} /></Part>
    </div>
  );
}
