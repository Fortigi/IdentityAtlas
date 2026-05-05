export const TIER_STYLES = {
  Critical: { bg: 'bg-red-100',    text: 'text-red-800',    border: 'border-red-200',    dot: 'bg-red-500',    avatar: '#ef4444', box: '#fef2f2', boxBorder: '#fca5a5',  darkBg: 'dark:bg-red-900/40',    darkText: 'dark:text-red-300',    darkBorder: 'dark:border-red-700',    darkBox: '#450a0a', darkBoxBorder: '#7f1d1d' },
  High:     { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200', dot: 'bg-orange-500', avatar: '#f97316', box: '#fff7ed', boxBorder: '#fdba74',  darkBg: 'dark:bg-orange-900/40', darkText: 'dark:text-orange-300', darkBorder: 'dark:border-orange-700', darkBox: '#431407', darkBoxBorder: '#7c2d12' },
  Medium:   { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', dot: 'bg-yellow-500', avatar: '#eab308', box: '#fefce8', boxBorder: '#fde047',  darkBg: 'dark:bg-yellow-900/40', darkText: 'dark:text-yellow-300', darkBorder: 'dark:border-yellow-700', darkBox: '#422006', darkBoxBorder: '#713f12' },
  Low:      { bg: 'bg-blue-100',   text: 'text-blue-800',   border: 'border-blue-200',   dot: 'bg-blue-500',  avatar: '#3b82f6', box: '#eff6ff', boxBorder: '#93c5fd',  darkBg: 'dark:bg-blue-900/40',   darkText: 'dark:text-blue-300',   darkBorder: 'dark:border-blue-700',   darkBox: '#0c1a2e', darkBoxBorder: '#1e3a5f' },
  Minimal:  { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-200',   dot: 'bg-gray-400',  avatar: '#9ca3af', box: '#f9fafb', boxBorder: '#d1d5db',  darkBg: 'dark:bg-gray-700',      darkText: 'dark:text-gray-400',   darkBorder: 'dark:border-gray-600',   darkBox: '#1f2937', darkBoxBorder: '#374151' },
  None:     { bg: 'bg-gray-50',    text: 'text-gray-500',   border: 'border-gray-100',   dot: 'bg-gray-300',  avatar: '#d1d5db', box: '#f3f4f6', boxBorder: '#e5e7eb',  darkBg: 'dark:bg-gray-800',      darkText: 'dark:text-gray-500',   darkBorder: 'dark:border-gray-700',   darkBox: '#111827', darkBoxBorder: '#1f2937' },
};

// Returns combined bg+text Tailwind classes for a tier badge, including dark variants.
export function tierClass(tier) {
  const s = TIER_STYLES[tier];
  if (!s) return '';
  return `${s.bg} ${s.text} ${s.darkBg} ${s.darkText}`;
}

// Returns inline style object for box/card uses, respecting dark mode.
export function tierBoxStyle(tier, isDark) {
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return isDark
    ? { backgroundColor: s.darkBox, borderColor: s.darkBoxBorder }
    : { backgroundColor: s.box, borderColor: s.boxBorder };
}
