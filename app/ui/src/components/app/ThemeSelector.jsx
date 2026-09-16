// Light / Auto / Dark segmented control for the settings dropdown.
const THEME_OPTIONS = [
  {
    value: 'light', label: 'Light',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="5" strokeWidth={2}/>
      <path strokeWidth={2} strokeLinecap="round"
        d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
    </svg>,
  },
  {
    value: 'auto', label: 'Auto',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="2" y="3" width="20" height="14" rx="2" strokeWidth={2}/>
      <path strokeWidth={2} strokeLinecap="round" d="M8 21h8M12 17v4"/>
    </svg>,
  },
  {
    value: 'dark', label: 'Dark',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeWidth={2} strokeLinecap="round"
        d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>
    </svg>,
  },
];

export default function ThemeSelector({ mode, setTheme }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-gray-700 dark:text-gray-300 shrink-0">Theme</span>
      <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs">
        {THEME_OPTIONS.map(({ value, label, icon }) => (
          <button
            key={value}
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={mode === value}
            className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${
              mode === value
                ? 'bg-blue-500 text-white'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
