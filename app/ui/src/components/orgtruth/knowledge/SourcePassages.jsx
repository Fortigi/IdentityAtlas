// The transcript as stored: its passages with their numbers (the §n the
// statements quote), plus speaker and time when the format carries them.
// Props: { passages }
import { formatDurationMs } from '@ui/utils/formatters';
import EmptyState from '@ui/components/EmptyState';
import { CARD } from '@ui/components/orgtruth/orgUi';

function where(p) {
  return [p.speaker, p.startMs != null ? formatDurationMs(p.startMs) : null].filter(Boolean).join(' · ');
}

export default function SourcePassages({ passages }) {
  const list = passages ?? [];
  if (list.length === 0) return <EmptyState title="No passages" hint="This transcript has no text." />;
  return (
    <ol className={`${CARD} divide-y divide-gray-100 dark:divide-gray-700`} aria-label="Passages">
      {list.map(p => (
        <li key={p.id} className="flex gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-300">
          <span className="w-10 shrink-0 text-xs text-gray-600 dark:text-gray-400">§{p.seq}</span>
          <div>
            {where(p) && <div className="text-xs text-gray-600 dark:text-gray-400">{where(p)}</div>}
            <p className="whitespace-pre-wrap">{p.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
