import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EntityLink from '@ui/components/EntityLink';
import { participantLabel, participantNotes, groupParticipants } from './accessModel';

// Who approves, who reviews and who may request this role, as its policies say.
// A named person links to their page, a group to the group; a request scope
// that matches a context exactly links to that context.

const SECTIONS = [
  { key: 'Approver', title: 'Approvers', empty: 'No approvers named.' },
  { key: 'Reviewer', title: 'Reviewers', empty: 'No reviewers named.' },
  { key: 'Requestor', title: 'Who can request it', empty: 'Nobody can request this role.' },
];

function Subject({ person, onOpenDetail }) {
  const label = participantLabel(person);
  if (person.principalId) {
    return <EntityLink kind="user" id={person.principalId} label={label} accessible={person.accessible} onOpenDetail={onOpenDetail} />;
  }
  if (person.groupId) {
    return <EntityLink kind="resource" id={person.groupId} label={label} accessible={person.groupAccessible} onOpenDetail={onOpenDetail} />;
  }
  return <span className={person.subjectType === 'Rule' ? 'break-all font-mono text-xs text-gray-800 dark:text-gray-200' : 'text-gray-900 dark:text-gray-100'}>{label}</span>;
}

function Person({ person, onOpenDetail }) {
  const notes = participantNotes(person);
  return (
    <li className="text-sm" data-testid="role-participant">
      <Subject person={person} onOpenDetail={onOpenDetail} />
      {notes.length > 0 && <span className="ml-1.5 text-xs text-gray-600 dark:text-gray-400">{notes.join(', ')}</span>}
      {person.contextId && (
        <span className="ml-1.5 text-xs text-gray-600 dark:text-gray-400">
          = <EntityLink kind="context" id={person.contextId} label={person.contextName} accessible={person.contextAccessible} onOpenDetail={onOpenDetail} />
        </span>
      )}
    </li>
  );
}

export default function BusinessRoleParticipants({ roleId, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/participants`, { authFetch, initialData: [] });
  if (loading) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">Could not load the approvers and reviewers.</p>;
  const grouped = groupParticipants(Array.isArray(data) ? data : []);
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {SECTIONS.map(({ key, title, empty }) => (
        <div key={key}>
          <h4 className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">{title}</h4>
          {grouped[key].length === 0
            ? <p className="text-xs text-gray-600 dark:text-gray-400">{empty}</p>
            : <ul className="space-y-1">{grouped[key].map(p => <Person key={p.key} person={p} onOpenDetail={onOpenDetail} />)}</ul>}
        </div>
      ))}
    </div>
  );
}
