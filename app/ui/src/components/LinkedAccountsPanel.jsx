import ConfidenceBar from './ConfidenceBar';
import { isSourceLinkedMember, memberAccountEnabled } from '@ui/utils/linkedMembers';

const EM_DASH = '—';

const TH = 'px-2 py-1.5 text-left font-medium text-gray-600 dark:text-gray-400';
const TD = 'px-2 py-2 align-top text-gray-700 dark:text-gray-300';

function EnabledCell({ enabled }) {
  if (enabled == null) return <span className="text-gray-600 dark:text-gray-400">{EM_DASH}</span>;
  return (
    <span className={`px-2 py-0.5 rounded-full ${enabled
      ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300'
      : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
      {enabled ? 'Yes' : 'No'}
    </span>
  );
}

function MemberActions({ member, busy, onOverride }) {
  const ov = member.analystOverride;
  if (isSourceLinkedMember(member)) {
    return <span className="text-xs text-gray-600 dark:text-gray-400 italic">Linked from source</span>;
  }
  return (
    <>
      <ConfidenceBar confidence={member.linkConfidence} />
      {ov && (
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          ov === 'confirmed' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-700'
            : ov === 'rejected' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-700'
              : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
        }`}>{ov}</span>
      )}
      {ov ? (
        <button disabled={busy} onClick={() => onOverride(member.principalId, 'clear')}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">Undo</button>
      ) : (
        <>
          <button disabled={busy} onClick={() => onOverride(member.principalId, 'confirmed')}
            className="text-xs px-2 py-1 rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50">Confirm</button>
          <button disabled={busy} onClick={() => onOverride(member.principalId, 'rejected')}
            className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50">Remove</button>
        </>
      )}
    </>
  );
}

function MemberRow({ member, busyMember, onOverride, onOpenDetail }) {
  return (
    <tr>
      <td className={TD}>{member.systemDisplayName || EM_DASH}</td>
      <td className={`${TD} min-w-0`}>
        <button onClick={() => onOpenDetail?.('user', member.principalId, member.displayName)}
          className="font-medium text-blue-700 dark:text-blue-300 hover:underline text-left truncate block max-w-full">
          {member.displayName}
        </button>
        {(member.userPrincipalName || member.isPrimary) && (
          <div className="text-xs text-gray-600 dark:text-gray-400 truncate">
            {member.userPrincipalName || ''}
            {member.userPrincipalName && member.isPrimary ? ' · ' : ''}
            {member.isPrimary ? 'primary' : ''}
          </div>
        )}
      </td>
      <td className={TD}><EnabledCell enabled={memberAccountEnabled(member)} /></td>
      <td className={TD}>{member.accountType || EM_DASH}</td>
      <td className={`${TD} text-right`}>
        <div className="flex items-center justify-end gap-2">
          <MemberActions member={member} busy={busyMember === member.principalId} onOverride={onOverride} />
        </div>
      </td>
    </tr>
  );
}

export default function LinkedAccountsPanel({ members, busyMember, onOverride, onOpenDetail }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Linked Accounts</h3>
      {members.length === 0 ? (
        <p className="text-xs text-gray-600 dark:text-gray-400 py-2">No linked accounts.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th scope="col" className={TH}>System</th>
              <th scope="col" className={TH}>Account</th>
              <th scope="col" className={TH}>Enabled</th>
              <th scope="col" className={TH}>Type</th>
              <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {members.map(m => (
              <MemberRow key={m.principalId} member={m} busyMember={busyMember}
                onOverride={onOverride} onOpenDetail={onOpenDetail} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
