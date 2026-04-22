export const TAG_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

// Light-mode AP pastel palette (15 colors)
export const AP_COLORS = [
  '#fde68a', '#a7f3d0', '#bfdbfe', '#ddd6fe', '#fbcfe8',
  '#fed7aa', '#99f6e4', '#c7d2fe', '#fecdd3', '#d9f99d',
  '#fef08a', '#a5f3fc', '#c4b5fd', '#fda4af', '#bef264',
];

// Dark-mode AP palette — same hue order, saturated darks
export const AP_COLORS_DARK = [
  '#92400e', '#065f46', '#1e40af', '#4c1d95', '#9d174d',
  '#9a3412', '#115e59', '#312e81', '#9f1239', '#3f6212',
  '#78350f', '#0c4a6e', '#3b0764', '#881337', '#365314',
];

export function getApColor(index, isDark) {
  const palette = isDark ? AP_COLORS_DARK : AP_COLORS;
  return palette[index % palette.length];
}

export const TYPE_COLORS = {
  Direct:   { letter: 'D', bg: '#166534', text: '#fff' },
  Indirect: { letter: 'I', bg: '#1e40af', text: '#fff' },
  Eligible: { letter: 'E', bg: '#854d0e', text: '#fff' },
  Owner:    { letter: 'O', bg: '#9d174d', text: '#fff' },
};
