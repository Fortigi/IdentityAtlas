// What a clean removes and keeps, as the API states it (GET
// /api/admin/clean-database/plan). The lists come from the server's table
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
