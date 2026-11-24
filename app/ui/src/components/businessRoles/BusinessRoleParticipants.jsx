import EntityLink from '@ui/components/EntityLink';
import { participantLabel, participantNotes } from './accessModel';

// A list of the people a policy names. A named person links to their page, a
// group to the group; a request scope that matches a context exactly links to
// that context.

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

export default function BusinessRoleParticipants({ people, onOpenDetail }) {
  return <ul className="space-y-1">{people.map(p => <Person key={p.key} person={p} onOpenDetail={onOpenDetail} />)}</ul>;
}
