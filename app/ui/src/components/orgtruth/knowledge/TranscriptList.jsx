// The transcripts table: name, date, speaker, passages and the latest run.
// Props: { rows, onOpen(id) }
import { formatDateOnly } from '@ui/utils/formatters';
import { StatusPill, TH, TD, CARD, LINK_BUTTON } from '@ui/components/orgtruth/orgUi';
import { isRunActive } from './knowledgeFormat';

function LastRun({ run }) {
  if (!run) return <span className="text-gray-600 dark:text-gray-400">not extracted</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusPill status={run.status} />
      {isRunActive(run) && <span>{run.pct ?? 0}%</span>}
    </span>
  );
}

export default function TranscriptList({ rows, onOpen }) {
  return (
    <div className={`${CARD} overflow-x-auto`}>
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700" aria-label="Transcripts">
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr>
            {['Name', 'Date', 'Speaker', 'Passages', 'Last run'].map(h => <th key={h} scope="col" className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map(s => (
            <tr key={s.id}>
              <td className={TD}>
                <button type="button" className={LINK_BUTTON} onClick={() => onOpen(s.id)}>{s.displayName}</button>
              </td>
              <td className={TD}>{formatDateOnly(s.observedAt)}</td>
              <td className={TD}>{s.metadata?.speaker || '—'}</td>
              <td className={TD}>{s.passageCount ?? s.metadata?.passageCount ?? 0}</td>
              <td className={TD}><LastRun run={s.lastRun} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
