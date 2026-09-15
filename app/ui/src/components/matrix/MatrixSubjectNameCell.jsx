import {
  subjectTitle, subjectLabel, identityGlyph, subjectAccountCount,
  subjectLabelMaxHeight, ACCOUNT_ROW_H,
} from './MatrixColumnHeaders.helpers';

// Header cell for a single subject. Identity columns get an expand control (into
// their linked accounts) and, when they have any, a count of them; account
// columns get a blue-tinted style.
//
// The same cell serves both header rows. On the names row it is sticky and 100px
// tall, and spans the accounts row (`rowSpan`) or its own account sub-columns
// (`colSpan`). On the accounts row (`inAccountsRow`) it is shorter and NOT
// sticky — a `top-0` cell there would pin on top of the names row.
export default function MatrixSubjectNameCell({
  user, expandedIdentities, onToggleIdentity, loadingIdentityCols, onOpenDetail,
  colSpan, rowSpan, inAccountsRow = false,
}) {
  const isIdentity = user.memberType === 'Identity';
  const isAcct = !!user.isAccountCol;
  const isExpanded = expandedIdentities?.has(user.id);
  const isLoadingCol = loadingIdentityCols?.has(user.id);
  const height = inAccountsRow ? `${ACCOUNT_ROW_H}px` : '100px';
  // Linked accounts this identity expands into — shown before expanding (so you
  // can tell which identities are worth a click) and kept while expanded.
  const accountCount = subjectAccountCount(user);
  return (
    <th
      colSpan={colSpan}
      rowSpan={rowSpan}
      className={`${inAccountsRow ? '' : 'sticky top-0 '}z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${
        isAcct ? 'bg-blue-50 dark:bg-blue-900/20 border-l border-l-blue-200 dark:border-l-blue-800' : 'bg-gray-100 dark:bg-gray-800'
      }`}
      style={{ height, width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
      title={subjectTitle(user)}
    >
      <div className="flex flex-col items-center justify-end h-full">
        {isIdentity && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleIdentity?.(user.id); }}
            className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
            title={isExpanded ? 'Collapse accounts' : 'Expand into linked accounts'}
          >
            {identityGlyph(isLoadingCol, isExpanded)}
          </button>
        )}
        {accountCount !== null && (
          <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0">
            {accountCount}
          </span>
        )}
        <div
          className={`text-[10px] font-medium cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 ${
            isAcct ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
          }`}
          style={{
            writingMode: 'vertical-lr',
            textOrientation: 'mixed',
            transform: 'rotate(180deg)',
            maxHeight: `${subjectLabelMaxHeight({ inAccountsRow, isIdentity, hasCount: accountCount !== null })}px`,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            margin: '0 auto',
          }}
          onClick={() => onOpenDetail?.(isIdentity ? 'identity' : 'user', user.id, user.displayName)}
        >
          {subjectLabel(user)}
        </div>
      </div>
    </th>
  );
}
