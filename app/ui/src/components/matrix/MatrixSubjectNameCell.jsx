import { subjectTitle, subjectLabel, identityGlyph } from './MatrixColumnHeaders.helpers';

// Names-row cell for a single subject. Identity columns get an expand control
// (into their linked accounts); account columns get a blue-tinted style.
export default function MatrixSubjectNameCell({
  user, expandedIdentities, onToggleIdentity, loadingIdentityCols, onOpenDetail,
}) {
  const isIdentity = user.memberType === 'Identity';
  const isAcct = !!user.isAccountCol;
  const isExpanded = expandedIdentities?.has(user.id);
  const isLoadingCol = loadingIdentityCols?.has(user.id);
  return (
    <th
      className={`sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${
        isAcct ? 'bg-blue-50 dark:bg-blue-900/20 border-l border-l-blue-200 dark:border-l-blue-800' : 'bg-gray-100 dark:bg-gray-800'
      }`}
      style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
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
        <div
          className={`text-[10px] font-medium cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 ${
            isAcct ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
          }`}
          style={{
            writingMode: 'vertical-lr',
            textOrientation: 'mixed',
            transform: 'rotate(180deg)',
            maxHeight: isIdentity ? '78px' : '95px',
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
