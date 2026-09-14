import { accountRollupTitle, ACCOUNT_ROW_H } from './MatrixColumnHeaders.helpers';
import MatrixSubjectNameCell from './MatrixSubjectNameCell';

// The header row directly under the names row, present only while at least one
// identity is expanded into its linked accounts. Each expanded identity's names
// cell spans this row, and the span is filled here by a roll-up cell for the
// identity's own column plus one cell per account.
//
// Every other column is covered by a rowSpan=2 cell on the names row, so this
// row deliberately holds nothing for them — no blank band appears.
export default function MatrixAccountsRow({ columns, accountsByParent, onOpenDetail }) {
  return (
    <tr>
      {columns.flatMap((user) => {
        const accounts = accountsByParent.get(user.id);
        if (!accounts?.length) return [];
        return [
          <th
            key={`${user.id}__rollup`}
            className="z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-gray-100 dark:bg-gray-800"
            style={{ height: `${ACCOUNT_ROW_H}px`, width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
            title={accountRollupTitle(user)}
          >
            <div
              className="text-[10px] font-medium text-gray-600 dark:text-gray-400 select-none"
              style={{
                writingMode: 'vertical-lr',
                textOrientation: 'mixed',
                transform: 'rotate(180deg)',
                maxHeight: `${ACCOUNT_ROW_H - 5}px`,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                margin: '0 auto',
              }}
            >
              All accounts
            </div>
          </th>,
          ...accounts.map((account) => (
            <MatrixSubjectNameCell
              key={account.id}
              user={account}
              onOpenDetail={onOpenDetail}
              inAccountsRow
            />
          )),
        ];
      })}
    </tr>
  );
}
