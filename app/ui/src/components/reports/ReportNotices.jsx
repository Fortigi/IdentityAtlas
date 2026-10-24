// Notices: what a report's rows were computed from, and when to stop trusting
// them.
//
// Rendered above the table for any report that returns them, keyed on the
// notice's `severity` and never on the report — a template says what needs
// saying and this draws it. A "0 rows" table and a "0 rows, because nothing was
// measured" table look identical without this.

const SEVERITY_STYLES = {
  warning: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  info: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
};

export default function ReportNotices({ notices }) {
  if (!notices?.length) return null;
  return (
    <div className="mb-3 space-y-2" role="status">
      {notices.map((notice, i) => (
        <p
          key={`${notice.severity}-${i}`}
          className={`rounded-lg border px-3 py-2 text-sm ${SEVERITY_STYLES[notice.severity] || SEVERITY_STYLES.info}`}
        >
          {notice.text}
        </p>
      ))}
    </div>
  );
}
