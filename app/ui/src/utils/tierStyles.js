export const TIER_STYLES = {
  Critical: { bg: 'bg-red-100',    text: 'text-red-800',    border: 'border-red-200',    dot: 'bg-red-500',    avatar: '#ef4444', box: '#fef2f2', boxBorder: '#fca5a5' },
  High:     { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200', dot: 'bg-orange-500', avatar: '#f97316', box: '#fff7ed', boxBorder: '#fdba74' },
  Medium:   { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', dot: 'bg-yellow-500', avatar: '#eab308', box: '#fefce8', boxBorder: '#fde047' },
  Low:      { bg: 'bg-blue-100',   text: 'text-blue-800',   border: 'border-blue-200',   dot: 'bg-blue-500',  avatar: '#3b82f6', box: '#eff6ff', boxBorder: '#93c5fd' },
  Minimal:  { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-200',   dot: 'bg-gray-400',  avatar: '#9ca3af', box: '#f9fafb', boxBorder: '#d1d5db' },
  None:     { bg: 'bg-gray-50',    text: 'text-gray-400',   border: 'border-gray-100',   dot: 'bg-gray-300',  avatar: '#d1d5db', box: '#f3f4f6', boxBorder: '#e5e7eb' },
};

// Returns a combined bg+text className string, e.g. for inline badge spans.
export function tierClass(tier) {
  const s = TIER_STYLES[tier];
  return s ? `${s.bg} ${s.text}` : '';
}
