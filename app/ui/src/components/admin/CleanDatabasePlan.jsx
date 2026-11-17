// What a clean removes and keeps (GET /api/admin/clean-database/plan), and what
// a finished clean reports. The lists come from the server's table
// classification — the same one the clean runs on — so this dialog cannot
// promise something the clean does not do. Nothing here is hard-coded.

const LIST = 'list-disc pl-5 space-y-0.5';

function Block({ title, children }) {
  return (
    <div className="mb-3">
      <p className="text-xs font-semibold text-yellow-900 dark:text-yellow-200 mb-1">{title}</p>
      {children}
    </div>
  );
}

export default function CleanDatabasePlan({ plan, backupUrl }) {
  return (
    <div className="text-xs text-yellow-800 dark:text-yellow-300">
      <Block title="Removed">
        <ul className={LIST}>{plan.removed.map(g => <li key={g.key}>{g.text}</li>)}</ul>
      </Block>
      <Block title="Kept">
        <ul className={LIST}>{plan.kept.map(g => <li key={g.key}>{g.text}</li>)}</ul>
      </Block>
      {plan.alsoRemoved.length > 0 && (
        <Block title="Your work that is removed anyway, because it hangs on removed data">
          <ul className={LIST}>{plan.alsoRemoved.map(a => <li key={a.what}>{a.what} — {a.because}.</li>)}</ul>
        </Block>
      )}
      {plan.keptButChanged.length > 0 && (
        <Block title="Kept, but changed">
          <ul className={LIST}>{plan.keptButChanged.map(k => <li key={k.what}>{k.what}.</li>)}</ul>
        </Block>
      )}
      <p className="mb-3">
        There is no undo.{' '}
        <a href={backupUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 dark:text-blue-400 underline">
          Make a backup first
        </a>{' '}
        if you might want any of the removed data back.
      </p>
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What a finished clean reports (POST /api/admin/clean-database).
export function CleanDatabaseResult({ result, onDismiss }) {
  const wiped = result.wiped || [];
  const alsoRemoved = result.alsoRemoved || [];
  return (
    <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded">
      <div className="font-medium text-green-800 dark:text-green-300 text-sm mb-2">Database cleaned</div>
      <div className="text-xs text-green-700 dark:text-green-400">
        Cleaned {plural(wiped.length, 'table')}
        {alsoRemoved.length > 0 && `; ${plural(alsoRemoved.length, 'kept table')} lost rows that hung on removed data`}
      </div>
      {wiped.length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-green-700 dark:text-green-400 cursor-pointer hover:underline">Show details</summary>
          <ul className="mt-1 text-xs text-green-600 dark:text-green-400 space-y-0.5">
            {wiped.map(w => <li key={w.table}><code>{w.table}</code>: {w.rowsAffected} rows</li>)}
            {alsoRemoved.map(a => <li key={`also-${a.table}`}><code>{a.table}</code>: {a.rowsAffected} rows (hung on removed data)</li>)}
          </ul>
        </details>
      )}
      <button onClick={onDismiss} className="mt-2 text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200">Dismiss</button>
    </div>
  );
}
