// The team at a glance, for the person who answers for a unit: business roles
// down, direct team members across, whether each role is rule based or manual
// for that person, what no role covers per person (click for the list), and who
// joined, left or changed role lately. The grid leaves out what is inside a role;
// a role's name opens its own page, which shows that.
// Data: GET /api/contexts/:id/team-overview (app/api/src/contexts/teamOverview.js).

import { Fragment, useState } from 'react';
import EntityLink from '@ui/components/EntityLink';
import { formatDateOnly } from '@ui/utils/formatters';
import UngovernedPanel from './UngovernedPanel';
import {
  changeSentence, changeTone, groupChanges, nameSeparator, ungovernedLabel,
  ORIGIN_KINDS, originKind, originKindsIn, roleMarkLabel,
} from './teamOverview.helpers';

const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6';
const HEADING = 'text-base font-semibold text-gray-900 dark:text-white';
const NOTE = 'text-sm text-gray-600 dark:text-gray-400';
const STICKY = 'sticky left-0 z-10 bg-white dark:bg-gray-800';
const PERSON_LINK = 'font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300';

// A person's name read bottom to top, as the roles on an application's page, so
// a whole team fits side by side.
const VERTICAL = 'inline-block max-h-40 rotate-180 truncate whitespace-nowrap [writing-mode:vertical-rl]';

const ROLE_LINK = 'text-left text-blue-700 hover:underline dark:text-blue-300';

const TONES = {
  added: 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200',
  removed: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200',
};

// Told apart by shape as well as colour: a lightning bolt for a rule, a person
// for a decision. Green and amber as the Type chips on the Business Roles list.
const MARKS = {
  automatic: { cls: 'bg-green-100 text-green-800 ring-1 ring-green-300 dark:bg-green-900/40 dark:text-green-200 dark:ring-green-700', path: 'M11 2 4 11.5h5L8 18l8-10h-5l1-6Z', fill: true },
  manual: { cls: 'bg-amber-100 text-amber-900 ring-1 ring-amber-400 dark:bg-amber-900/40 dark:text-amber-100 dark:ring-amber-500', path: 'M10 9.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM3.5 17c.6-3.4 3.2-5 6.5-5s5.900 1.600 6.500 5' },
  unknown: { cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200', path: 'M4 10.500l4 4 8-9' },
};

function OriginIcon({ kind }) {
  const mark = MARKS[kind];
  return (
    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${mark.cls}`}>
      <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill={mark.fill ? 'currentColor' : 'none'} stroke={mark.fill ? 'none' : 'currentColor'} strokeWidth="2" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d={mark.path} />
      </svg>
    </span>
  );
}

function HeldMark({ held, role, person }) {
  if (!held) return <span className="sr-only">{person} does not hold {role}</span>;
  const label = roleMarkLabel(person, role, held);
  return <span role="img" aria-label={label} title={label} className="inline-flex"><OriginIcon kind={originKind(held.control)} /></span>;
}

function OriginLegend({ roles }) {
  const kinds = originKindsIn(roles);
  if (kinds.length === 0) return null;
  return (
    <ul aria-label="How a role is assigned" className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
      {kinds.map(k => (
        <li key={k} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <OriginIcon kind={k} />
          <span><span className="font-medium">{ORIGIN_KINDS[k].label}</span>: {ORIGIN_KINDS[k].help}</span>
        </li>
      ))}
    </ul>
  );
}

function UngovernedCount({ person, onOpen }) {
  const label = ungovernedLabel(person);
  if (person.ungoverned === 0) {
    return <span aria-label={label} title={label} className="inline-block min-w-8 px-1.5 py-0.5 text-sm font-semibold tabular-nums text-gray-600 dark:text-gray-400">0</span>;
  }
  return (
    <button type="button" onClick={() => onOpen(person)} aria-label={`${label}. Show them`} title="Show which permissions"
      className="inline-block min-w-8 rounded bg-amber-50 px-1.5 py-0.5 text-sm font-semibold tabular-nums text-amber-900 underline decoration-dotted underline-offset-2 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50">
      {person.ungoverned}
    </button>
  );
}

function RoleMatrix({ people, roles, onOpenDetail, onOpenUngoverned }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Business roles per team member</caption>
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th scope="col" className={`${STICKY} min-w-56 py-2 pr-4 text-left align-bottom text-xs font-medium text-gray-600 dark:text-gray-400`}>Business role</th>
            {people.map(p => (
              <th key={p.id} scope="col" className="w-10 px-1 py-2 text-center align-bottom text-xs font-medium">
                <span title={p.displayName} className={VERTICAL}>
                  <EntityLink kind={p.kind} id={p.id} label={p.displayName} accessible={p.accessible} onOpenDetail={onOpenDetail} className={PERSON_LINK} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map(role => (
            <tr key={role.id} className="border-b border-gray-100 dark:border-gray-700/60">
              <th scope="row" className={`${STICKY} py-2 pr-4 text-left font-normal text-gray-900 dark:text-gray-100`}>
                <EntityLink kind="access-package" id={role.id} label={role.displayName} accessible={role.accessible} onOpenDetail={onOpenDetail} className={ROLE_LINK} />
              </th>
              {people.map(p => (
                <td key={p.id} className="px-1 py-1.5 text-center">
                  <HeldMark held={role.holders.includes(p.id) ? (role.origins?.[p.id] || {}) : null} role={role.displayName} person={p.displayName} />
                </td>
              ))}
            </tr>
          ))}
          {roles.length === 0 && (
            <tr><td colSpan={people.length + 1} className={`${NOTE} py-3`}>Nobody in this team holds a business role yet.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-200 dark:border-gray-600">
            <th scope="row" className={`${STICKY} py-2.5 pr-4 text-left font-medium text-gray-900 dark:text-gray-100`}>
              Ungoverned permissions
              <span className="block text-xs font-normal text-gray-600 dark:text-gray-400">Access no business role explains. Click a number to see it.</span>
            </th>
            {people.map(p => <td key={p.id} className="px-1 py-2.5 text-center"><UngovernedCount person={p} onOpen={onOpenUngoverned} /></td>)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ChangeRow({ change, onOpenDetail }) {
  const tone = changeTone(change);
  return (
    <li className="flex items-center gap-3 py-2">
      <span aria-hidden="true" className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${TONES[tone]}`}>
        {tone === 'added' ? '+' : '−'}
      </span>
      <span className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-200">
        {change.people.map((p, i) => (
          <Fragment key={p.id}>
            <EntityLink kind={p.kind} id={p.id} label={p.name} accessible={p.accessible} onOpenDetail={onOpenDetail} className={PERSON_LINK} />
            {nameSeparator(i, change.people.length)}
          </Fragment>
        ))}
        {changeSentence(change, change.people.length)}
      </span>
      <time dateTime={change.at} className="shrink-0 text-xs text-gray-600 dark:text-gray-400">{formatDateOnly(change.at)}</time>
    </li>
  );
}

export default function TeamOverview({ contextId, overview, onOpenDetail }) {
  const { people, roles, changes, sinceDays, totalPeople, truncated } = overview;
  const [ungovernedOf, setUngovernedOf] = useState(null);
  return (
    <>
      <section aria-label="Your team" className={CARD}>
        <h2 className={HEADING}>Your team <span className="ml-1 text-sm font-normal text-gray-600 dark:text-gray-400">{totalPeople} {totalPeople === 1 ? 'person' : 'people'}</span></h2>
        <p className={NOTE}>Which business roles your direct team members hold, and how they got them.</p>
        <OriginLegend roles={roles} />
        {people.length === 0
          ? <p className={`${NOTE} mt-4`}>Nobody is in this team right now.</p>
          : <RoleMatrix people={people} roles={roles} onOpenDetail={onOpenDetail} onOpenUngoverned={setUngovernedOf} />}
      </section>
      <section aria-label="Recent changes" className={CARD}>
        <h2 className={HEADING}>Recent changes <span className="ml-1 text-sm font-normal text-gray-600 dark:text-gray-400">last {sinceDays} days</span></h2>
        {changes.length === 0
          ? <p className={`${NOTE} mt-2`}>Nobody joined or left, and no business roles changed.</p>
          : (
            <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700/60">
              {groupChanges(changes).map(c => <ChangeRow key={c.key} change={c} onOpenDetail={onOpenDetail} />)}
            </ul>
          )}
        {truncated && <p className={`${NOTE} mt-2`}>This overview is partial: the team or its history is larger than can be shown here.</p>}
      </section>
      {ungovernedOf && (
        <UngovernedPanel contextId={contextId} person={ungovernedOf} onClose={() => setUngovernedOf(null)} onOpenDetail={onOpenDetail} />
      )}
    </>
  );
}
