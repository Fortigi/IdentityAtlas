// "Reviewed By" cell — an Auto badge for system-completed reviews, the raw name
// otherwise, or a dash when unknown.
export default function ReviewedByCell({ value }) {
  if (!value) return <span className="text-gray-500 dark:text-gray-500">-</span>;
  if (/^AAD Access Review/i.test(value)) {
    return (
      <span
        className="inline-flex items-center gap-1 text-orange-600"
        title="This review was auto-completed by the system (reviewer did not respond before the deadline)"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" /></svg>
        Auto
      </span>
    );
  }
  return value;
}
