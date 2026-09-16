// App shell footer: version button + an "edge" badge for dev-build versions.
const EDGE_VERSION_RE = /^\d+\.\d+\.\d{8}\.\d{4}$/;

export default function AppFooter({ moduleVersion, navigate }) {
  return (
    <footer className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-2 text-xs text-gray-600 dark:text-gray-500 text-center flex items-center justify-center gap-2">
      <button
        onClick={() => navigate('admin?sub=about')}
        className="hover:text-gray-600 dark:hover:text-gray-300 hover:underline focus:outline-none"
      >
        Identity Atlas{moduleVersion ? ` v${moduleVersion}` : ''}
      </button>
      {EDGE_VERSION_RE.test(moduleVersion) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700">
          edge
        </span>
      )}
    </footer>
  );
}
