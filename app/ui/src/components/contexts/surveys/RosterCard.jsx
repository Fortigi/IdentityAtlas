import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { Modal } from '@ui/components/contexts/ModalPrimitives';
import { buildRoster, rosterCounts } from './roster.helpers';

// Action card + view: the unit's roster — who works here by what the claims say
// (surveys and interviews alike), their role and what they answer for, coloured
// as an analyst colours the spreadsheet after a first talk with the manager:
// green established, red gone, amber nobody has said. Italic: not yet reviewed.
// A reader without data.write.contexts sees confirmed claims only (the API decides).

export const MEMBER_LIMIT = 500;

const ROW = {
  here: 'bg-green-50 dark:bg-green-900/20',
  gone: 'bg-red-50 dark:bg-red-900/20',
  unknown: 'bg-amber-50 dark:bg-amber-900/20',
};
const STATE_LABEL = { here: 'Works here', gone: 'Left', unknown: 'Not established' };
const DOT = { here: 'bg-green-600', gone: 'bg-red-600', unknown: 'bg-amber-500' };

function Legend({ counts }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-gray-700 dark:text-gray-300">
      {Object.keys(STATE_LABEL).map(s => (
        <span key={s} className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-full ${DOT[s]}`} aria-hidden="true" />{STATE_LABEL[s]} ({counts[s]})</span>
      ))}
      <span className="italic">Italic: not reviewed yet</span>
    </div>
  );
}

export function RosterTable({ rows }) {
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-700/50 dark:text-gray-300">
        <tr>
          <th className="px-2 py-1.5 font-medium">Name</th>
          <th className="px-2 py-1.5 font-medium">Job title</th>
          <th className="px-2 py-1.5 font-medium">Department</th>
          <th className="px-2 py-1.5 font-medium">Status</th>
          <th className="px-2 py-1.5 font-medium">Role</th>
          <th className="px-2 py-1.5 font-medium">Responsible for</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white dark:divide-gray-800">
        {rows.map(r => (
          <tr key={r.key} className={`${ROW[r.state]} ${r.reviewed ? '' : 'italic'}`} data-state={r.state}>
            <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-white">
              {r.name}{!r.member && <span className="ml-1 text-xs font-normal text-gray-600 dark:text-gray-400">(not a member)</span>}
              {r.roles.length > 0 && <span className="ml-1 text-xs font-normal text-gray-700 dark:text-gray-300">· {r.roles.join(', ')}</span>}
            </td>
            <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{r.jobTitle ?? ''}</td>
            <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{r.department ?? ''}</td>
            <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{STATE_LABEL[r.state]}</td>
            <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{r.role ?? ''}</td>
            <td className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{r.responsibleFor.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RosterModal({ contextId, name, onClose }) {
  const { authFetch } = useAuth();
  const claimsCtx = useContextClaims();
  const { data: members, loading, error } = useFetch(`/api/contexts/${contextId}/members?limit=${MEMBER_LIMIT}`, {
    authFetch, initialData: [], transform: b => b.data || [],
  });
  const rows = useMemo(() => buildRoster(members, claimsCtx?.claims || []), [members, claimsCtx?.claims]);
  return (
    <Modal title={`Roster: ${name}`} subtitle="What surveys and interviews say about the people of this unit." onClose={onClose} width={1000}>
      <div className="space-y-3">
        <Legend counts={rosterCounts(rows)} />
        {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">The members could not be loaded.</p>}
        {!loading && <div className="max-h-[65vh] overflow-auto"><RosterTable rows={rows} /></div>}
        {members.length >= MEMBER_LIMIT && <p className="text-xs text-gray-600 dark:text-gray-400">Showing the first {MEMBER_LIMIT} members.</p>}
      </div>
    </Modal>
  );
}

export default function RosterCard({ attrs }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-roster">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Roster</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        Who works here, their role and what they answer for — by what the manager and others said.
      </p>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-900/30">
        View roster
      </button>
      {open && <RosterModal contextId={attrs.id} name={attrs.displayName} onClose={() => setOpen(false)} />}
    </div>
  );
}
