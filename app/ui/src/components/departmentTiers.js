// Shared risk-tier constants for the Department detail view and its panels.
export const TIER_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Minimal: 1, None: 0 };
export const TIER_DISPLAY = ['Critical', 'High', 'Medium', 'Low', 'Minimal'];
// Soft (-400) tier fills so the distribution bar matches the app's gentle
// palette while still reading as a severity ramp; thin marks/text elsewhere
// keep the stronger tiers. See the UI Style Guide § saturation.
export const TIER_BAR_COLORS = {
  Critical: '#f87171', High: '#fb923c', Medium: '#facc15', Low: '#60a5fa', Minimal: '#9ca3af', None: '#e5e7eb',
};
