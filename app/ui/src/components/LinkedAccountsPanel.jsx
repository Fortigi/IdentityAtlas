import ConfidenceBar from './ConfidenceBar';
import { isSourceLinkedMember } from '@ui/utils/linkedMembers';

export default function LinkedAccountsPanel({ members, busyMember, onOverride, onOpenDetail }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Linked Accounts</h3>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {members.map(m => {
          const ov = m.analystOverride;
          const busy = busyMember === m.principalId;
          const isSource = isSourceLinkedMember(m);
          return (
            <div key={m.principalId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <button onClick={() => onOpenDetail?.('user', m.principalId, m.displayName)}
                  className="text-sm font-medium text-blue-700 dark:text-blue-300 hover:underline text-left truncate block max-w-full">
                  {m.displayName}
                </button>
                <div className="text-xs text-gray-600 dark:text-gray-400 truncate">
                  {m.accountType || 'Account'}
                  {m.isPrimary ? ' · primary' : ''}
                  {m.userPrincipalName ? ` · ${m.userPrincipalName}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isSource ? (
                  <span className="text-xs text-gray-500 dark:text-gray-400 italic">Linked from source</span>
                ) : (
                  <>
                    {m.linkConfidence != null && <ConfidenceBar confidence={m.linkConfidence} />}
                    {ov && (
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        ov === 'confirmed' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-700'
                          : ov === 'rejected' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-700'
                            : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
                      }`}>{ov}</span>
                    )}
                    {ov ? (
                      <button disabled={busy} onClick={() => onOverride(m.principalId, 'clear')}
                        className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">Undo</button>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => onOverride(m.principalId, 'confirmed')}
                          className="text-xs px-2 py-1 rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50">Confirm</button>
                        <button disabled={busy} onClick={() => onOverride(m.principalId, 'rejected')}
                          className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50">Remove</button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {members.length === 0 && (
          <p className="text-xs text-gray-600 dark:text-gray-400 py-2">No linked accounts.</p>
        )}
      </div>
    </div>
  );
}
