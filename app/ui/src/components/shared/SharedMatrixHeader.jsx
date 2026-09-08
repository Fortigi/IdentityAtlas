// Header bar of the shared-matrix shell (#1166).
//
// Deliberately minimal: the product mark, the share's name, and — while a
// detail page is open inside the shell — a way back to the matrix. No nav, no
// settings, no sign-out; a business user opening a link should see the thing
// they were sent and nothing that invites them elsewhere.

import Brand from '@ui/components/app/Brand';

export default function SharedMatrixHeader({ isDark, shareName, onBackToMatrix }) {
  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-6 py-3 flex items-center gap-4">
        <Brand isDark={isDark} />

        <div className="flex-1 min-w-0 text-center">
          {shareName && (
            <>
              <p className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
                Shared matrix
              </p>
              <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={shareName}>
                {shareName}
              </p>
            </>
          )}
        </div>

        <div className="w-56 flex justify-end">
          {onBackToMatrix && (
            <button
              type="button"
              onClick={onBackToMatrix}
              className="inline-flex items-center gap-1.5 rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to matrix
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
