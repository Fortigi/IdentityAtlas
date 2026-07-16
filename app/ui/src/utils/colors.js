// WCAG 2.0 AA compliant (≥4.5:1 on white) — Tailwind 700–800 tier
export const TAG_COLORS = [
  '#1d4ed8', '#047857', '#92400e', '#b91c1c', '#6d28d9',
  '#be185d', '#0f766e', '#9a3412', '#4338ca', '#3f6212',
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

export function getAccessPackageColor(index, isDark) {
  const palette = isDark ? AP_COLORS_DARK : AP_COLORS;
  return palette[index % palette.length];
}

// ── Contrast-safe tag / category pill colours ───────────────────────────────
// Tag and category colours arrive as arbitrary hex (from the TAG_COLORS picker
// or from imported data). The old pills built their look inline as
// `{ backgroundColor: color+'20', borderColor: color, color: color }` — the raw
// colour as *text*. That fails WCAG contrast in two ways: a pale category colour
// on a near-white tint in light mode, and (worse) a dark colour as text on a
// dark tint in dark mode. `tagPillStyle` keeps the coloured look but nudges the
// text toward black (light) / white (dark) until it clears AA (4.5:1) against
// the tinted background, per the active theme.

const _DARK_SURFACE = { r: 31, g: 41, b: 55 };  // gray-800 — the pill's dark-mode backdrop
const _WHITE = { r: 255, g: 255, b: 255 };
const _BLACK = { r: 0, g: 0, b: 0 };

function _hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _rgbToHex({ r, g, b }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function _mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function _relLuminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
// WCAG contrast ratio between two rgb colours.
export function contrastRatio(a, b) {
  const la = _relLuminance(a);
  const lb = _relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Returns inline styles for a tag/category pill whose text is nudged to clear
// WCAG AA (4.5:1) against the tinted background for the active theme.
export function tagPillStyle(hex, isDark = false) {
  const base = _hexToRgb(hex) || (isDark ? { r: 156, g: 163, b: 175 } : { r: 75, g: 85, b: 99 }); // gray-400 / gray-600 fallback
  // Round the background once and measure against the *rounded* text, so the AA
  // check reflects the emitted #rrggbb values (rounding can shave ~0.01 off the
  // ratio and would otherwise let a 4.49 slip through).
  const bgHex = _rgbToHex(isDark ? _mix(base, _DARK_SURFACE, 0.82) : _mix(base, _WHITE, 0.86));
  const bgRounded = _hexToRgb(bgHex);
  const toward = isDark ? _WHITE : _BLACK;
  let text = base;
  // Nudge toward white (dark theme) / black (light theme) until the text clears
  // AA. The bg is a near-white / near-gray-800 tint, so pure white/black always
  // clears eventually; 24 steps is a safe upper bound before that limit.
  for (let i = 0; i < 24 && contrastRatio(_hexToRgb(_rgbToHex(text)), bgRounded) < 4.5; i++) {
    text = _mix(text, toward, 0.12);
  }
  const border = isDark ? _mix(base, _WHITE, 0.25) : base;
  return { backgroundColor: bgHex, borderColor: _rgbToHex(border), color: _rgbToHex(text) };
}

// Matrix cell / legend badge colours, keyed by membershipType. The matrix view
// (vw_ResourceUserPermissionAssignments) collapses every source assignment type
// onto how the access is HELD, so only these three ever render as badges — on
// screen and in the Excel export legend alike. The retired types that used to
// have swatches here (Owner/Governed/OAuth2Grant/AppRole/AppRoleViaGroup) can no
// longer appear in the data; see app/api/src/ingest/assignmentTypes.guard.test.js.
export const TYPE_COLORS = {
  Direct:   { letter: 'D', bg: '#166534', text: '#fff' },
  Indirect: { letter: 'I', bg: '#1e40af', text: '#fff' },
  Eligible: { letter: 'E', bg: '#854d0e', text: '#fff' },
};
