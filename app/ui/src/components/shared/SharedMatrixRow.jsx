// One row of the Shared matrices table (#1166).
//
// The "opened by" cell is the point of the page: a share nobody ever opened
// reads as "Never opened" rather than a blank or a zero buried in a column, so
// unused links are easy to spot and clean up.

import { formatDate, formatRelativeTime } from '@ui/utils/formatters';

function UsageCell({ usage, accessCount }) {
  if (!usage || usage.length === 0) {
    return <span className="text-amber-700 dark:text-amber-300">Never opened</span>;
  }
  return (
    <div className="space-y-0.5">
      {usage.map(u => (
        <div key={u.userKey} className="whitespace-nowrap text-gray-700 dark:text-gray-300">
          <span className="font-medium">{u.userKey}</span>
          <span className="text-gray-600 dark:text-gray-400">
            {' — '}{u.accessCount}×, last {formatRelativeTime(u.lastAccessAt)}
          </span>
        </div>
      ))}
      <div className="text-xs text-gray-600 dark:text-gray-400">
        {accessCount} view{accessCount === 1 ? '' : 's'} in total
      </div>
    </div>
  );
}

function StatusCell({ share }) {
  if (share.revokedAt) {
    return (
      <span
        className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300"
        title={`Revoked by ${share.revokedBy || 'unknown'} on ${formatDate(share.revokedAt)}`}
      >
        Revoked
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/20 dark:text-green-300">
      Active
    </span>
  );
}

export default function SharedMatrixRow({ share, busy, onRevoke }) {
  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <span className="font-medium text-gray-900 dark:text-gray-100">{share.name}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-gray-700 dark:text-gray-300">
        {share.createdBy || 'unknown'}
        <div className="text-xs text-gray-600 dark:text-gray-400">{formatDate(share.createdAt)}</div>
      </td>
      <td className="px-4 py-3 text-xs">
        <UsageCell usage={share.usage} accessCount={share.accessCount} />
      </td>
      <td className="px-4 py-3"><StatusCell share={share} /></td>
      <td className="px-4 py-3 text-right">
        {!share.revokedAt && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onRevoke(share)}
            className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30"
          >
            {busy ? 'Revoking…' : 'Revoke'}
          </button>
        )}
      </td>
    </tr>
  );
}
