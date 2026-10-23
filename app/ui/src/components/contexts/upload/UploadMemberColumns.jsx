import { KIND_OPTIONS, SHAPE_OPTIONS, addMemberColumn, updateMember, removeMember, aiSuggested } from './uploadMapping.helpers';
import AiMark from './AiMark';

// The member columns of a list: which column, what it holds (people, accounts,
// resources) and how (several per cell, or one per row with the key repeated).
// Each kind of member becomes its own tree; at most two.

const SELECT = 'border rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

export default function UploadMemberColumns({ mapping, columns, aiFields, onChange }) {
  const rows = mapping.memberColumns;
  return (
    <div>
      <div className="flex items-center text-xs font-medium text-gray-700 dark:text-gray-300">
        Members<AiMark show={aiSuggested(aiFields, 'memberColumns')} />
      </div>
      {rows.length === 0 && <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">No member columns: the units are created empty.</p>}
      {rows.length > 0 && (
        <table className="mt-1 w-full text-xs">
          <thead>
            <tr className="text-left text-gray-600 dark:text-gray-400">
              <th className="font-normal">Column</th><th className="font-normal">Holds</th><th className="font-normal">Shape</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={`${m.column}-${i}`}>
                <td className="py-0.5 pr-1">
                  <select aria-label={`Member column ${i + 1}`} value={m.column} className={SELECT} onChange={e => onChange(updateMember(mapping, i, { column: e.target.value }))}>
                    {columns.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="py-0.5 pr-1">
                  <select aria-label={`What ${m.column} holds`} value={m.kind} className={SELECT} onChange={e => onChange(updateMember(mapping, i, { kind: e.target.value }))}>
                    {KIND_OPTIONS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </td>
                <td className="py-0.5 pr-1">
                  <select aria-label={`Shape of ${m.column}`} value={m.shape} className={SELECT} onChange={e => onChange(updateMember(mapping, i, { shape: e.target.value }))}>
                    {SHAPE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </td>
                <td className="py-0.5 text-right">
                  <button type="button" aria-label={`Remove member column ${m.column}`} onClick={() => onChange(removeMember(mapping, i))}
                    className="text-gray-600 hover:text-red-700 dark:text-gray-400 dark:hover:text-red-400">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" onClick={() => onChange(addMemberColumn(mapping, columns))}
        className="mt-1 text-[11px] text-blue-700 hover:underline dark:text-blue-400">+ Add a member column</button>
    </div>
  );
}
