import ThemeSelector from './ThemeSelector';

// Header account button + its dropdown (user info, theme selector, per-user tab
// visibility toggles, sign out). The wrapping div carries the outside-click ref
// owned by App.
export default function SettingsMenu({
  settingsRef, account, settingsOpen, onToggle, onClose,
  mode, setTheme, optionalTabs, visibleTabs, toggleTab, logout,
}) {
  return (
    <div className="flex items-center gap-3 relative" ref={settingsRef}>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        title="Settings"
      >
        <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">
          {(account?.name || account?.username || '?')[0].toUpperCase()}
        </div>
        <span className="hidden sm:inline">{account?.name || account?.username || 'User'}</span>
        <svg className={`w-3.5 h-3.5 text-gray-600 dark:text-gray-500 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {settingsOpen && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          {/* User info */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-900 dark:text-white">{account?.name || 'User'}</p>
            {account?.username && <p className="text-xs text-gray-500 dark:text-gray-400">{account.username}</p>}
          </div>

          {/* Theme selector */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <ThemeSelector mode={mode} setTheme={setTheme} />
          </div>

          {/* Tab visibility toggles */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Visible Tabs</p>
            {optionalTabs.map(tab => (
              <label key={tab.key} className="flex items-center justify-between py-1.5 cursor-pointer group">
                <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white">{tab.label}</span>
                <button
                  onClick={() => toggleTab(tab.key)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    visibleTabs?.includes(tab.key) ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                    style={{ transform: visibleTabs?.includes(tab.key) ? 'translateX(18px)' : 'translateX(2px)' }}
                  />
                </button>
              </label>
            ))}
          </div>

          {/* Sign out */}
          {account && (
            <div className="px-4 py-2">
              <button
                onClick={() => { onClose(); logout(); }}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 w-full text-left py-1"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
