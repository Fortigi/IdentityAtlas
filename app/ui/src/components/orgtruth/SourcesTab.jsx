// Organisation → Sources (workstream T6).
//
// Lists every uploaded source (GET /api/org-truth/sources): name, kind, observed
// date, uploader, size, and the runs it fed (GET /api/org-truth/runs). A row
// offers Download (the original bytes) and, for someone who may import,
// "Import again", which opens the wizard in repeat mode with the profile of the
// source's most recent run. Expanding a row lists its runs with their stats.
//
// A failing runs list does not hide the sources: the run columns fall back to
// the source's own runCount, and the expanded list says the runs are unavailable.
//
// Props: { onImport(), onImportAgain(profileId) }
import { Fragment, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import EmptyState from '@ui/components/EmptyState';
import { formatDate, formatBytes } from '@ui/utils/formatters';
import { fetchBlocked, rowsOf, runsForSource, lastProfileId, runStatsSummary } from './orgFormat';
import { useSourceDownload } from './sourceDownload';
import { useSourceDelete } from './sourceDelete';
import { FetchState, StatusPill, TH, TD, CARD, SMALL_BUTTON } from './orgUi';

function RunsList({ runs, runsError }) {
  if (runsError) return <p className="text-xs text-gray-600 dark:text-gray-400">The runs are not available.</p>;
  if (runs.length === 0) return <p className="text-xs text-gray-600 dark:text-gray-400">No runs yet.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th scope="col" className={TH}>Mode</th>
          <th scope="col" className={TH}>Status</th>
          <th scope="col" className={TH}>Started</th>
          <th scope="col" className={TH}>Finished</th>
          <th scope="col" className={TH}>Result</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
        {runs.map(r => (
          <tr key={r.id}>
            <td className={TD}>{r.mode}</td>
            <td className={TD}><StatusPill status={r.status} /></td>
            <td className={TD}>{formatDate(r.startedAt)}</td>
            <td className={TD}>{formatDate(r.finishedAt)}</td>
            <td className={TD}>{r.error || runStatsSummary(r.stats)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DANGER_BUTTON = 'text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50';

function SourceRow({ source, sourceRuns, runsError, expanded, onToggle, canImport, onDownload, onImportAgain, onDelete }) {
  const profileId = lastProfileId(sourceRuns);
  const runCount = source.runCount ?? sourceRuns.length;
  return (
    <Fragment>
      <tr>
        <td className={TD}>
          <button type="button" onClick={onToggle} aria-expanded={expanded}
            className="font-medium text-gray-900 dark:text-gray-100 hover:underline text-left">
            {source.displayName}
          </button>
          {source.fileName && source.fileName !== source.displayName && (
            <div className="text-xs text-gray-600 dark:text-gray-400">{source.fileName}</div>
          )}
        </td>
        <td className={TD}>{source.kind}</td>
        <td className={TD}>{formatDate(source.observedAt)}</td>
        <td className={TD}>{source.uploadedBy || '—'}</td>
        <td className={TD}>{source.byteSize != null ? formatBytes(source.byteSize) : '—'}</td>
        <td className={TD}>
          <span className="mr-2">{runCount}</span>
          <StatusPill status={sourceRuns[0]?.status} />
        </td>
        <td className={`${TD} text-right whitespace-nowrap`}>
          <div className="flex justify-end gap-2">
            <button type="button" className={SMALL_BUTTON} onClick={() => onDownload(source)}>Download</button>
            {canImport && profileId && (
              <button type="button" className={SMALL_BUTTON} onClick={() => onImportAgain?.(profileId)}>Import again</button>
            )}
            {canImport && (
              <button type="button" className={DANGER_BUTTON} onClick={() => onDelete(source)} aria-label={`Delete ${source.displayName}`}>Delete</button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="px-6 py-3 bg-gray-50 dark:bg-gray-900/40">
            <RunsList runs={sourceRuns} runsError={runsError} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default function SourcesTab({ onImport, onImportAgain }) {
  const { authFetch } = useAuth();
  const onDownload = useSourceDownload(authFetch);
  const deleteSource = useSourceDelete(authFetch);
  const canImport = useCanImportOrgTruth();
  const sources = useFetch('/api/org-truth/sources', { authFetch });
  const runs = useFetch('/api/org-truth/runs', { authFetch });
  const [expanded, setExpanded] = useState(null);
  const onDelete = async (source) => {
    if (await deleteSource(source)) { sources.reload(); runs.reload(); }
  };

  if (fetchBlocked(sources)) return <FetchState state={sources} what="Sources" />;

  const rows = rowsOf(sources.data);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No organisation sources yet"
        hint="Upload a list of projects, assets, teams or data domains with their owners to start."
        actionLabel={canImport ? 'Import organisation truth' : undefined}
        onAction={onImport}
      />
    );
  }

  const allRuns = rowsOf(runs.data);

  return (
    <div className="space-y-3">
      {canImport && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onImport}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            Import organisation truth
          </button>
        </div>
      )}
    <div className={`${CARD} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr>
            <th scope="col" className={TH}>Name</th>
            <th scope="col" className={TH}>Kind</th>
            <th scope="col" className={TH}>Observed</th>
            <th scope="col" className={TH}>Uploaded by</th>
            <th scope="col" className={TH}>Size</th>
            <th scope="col" className={TH}>Runs</th>
            <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map(s => (
            <SourceRow
              key={s.id}
              source={s}
              sourceRuns={runsForSource(allRuns, s.id)}
              runsError={runs.error}
              expanded={expanded === s.id}
              onToggle={() => setExpanded(cur => (cur === s.id ? null : s.id))}
              canImport={canImport}
              onDownload={onDownload}
              onImportAgain={onImportAgain}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
