// Action card for work that is announced but not built yet: its title, a
// "Coming soon" tag, what it will do, and a disabled button that does nothing.
// The intended flows are in docs/architecture/ownership-survey.md.
export default function ComingSoonCard({ title, text, button, testId }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid={testId}>
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">Coming soon</span>
      </div>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">{text}</p>
      <button type="button" disabled
        className="cursor-not-allowed rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-500 opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
        {button}
      </button>
    </div>
  );
}
