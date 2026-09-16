import MatrixSubjectNameCell from './MatrixSubjectNameCell';

// The header row directly under the names row, present only while at least one
// identity is expanded into its linked accounts. An expanded identity's names
// cell spans this row, and the span is filled here by one cell per account — the
// identity itself has no column while expanded; collapsing it brings its
// combined column back.
//
// Every other column is covered by a rowSpan=2 cell on the names row, so this
// row deliberately holds nothing for them — no blank band appears.
export default function MatrixAccountsRow({ columns, accountsByParent, onOpenDetail }) {
  return (
    <tr>
      {columns.flatMap((user) => (accountsByParent.get(user.id) || []).map((account) => (
        <MatrixSubjectNameCell
          key={account.id}
          user={account}
          onOpenDetail={onOpenDetail}
          inAccountsRow
        />
      )))}
    </tr>
  );
}
