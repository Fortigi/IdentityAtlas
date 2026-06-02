# React UI — Coding Guide

## Dark Mode

The UI supports a light/dark theme toggle via Tailwind v4's class-based dark mode.

**How it works:**
- `index.css` declares `@custom-variant dark (&:is(.dark, .dark *))` — the `dark` class on `<html>` activates all `dark:` variants.
- `src/hooks/useTheme.js` — three-state machine (`'light' | 'auto' | 'dark'`); `'auto'` follows the OS via `matchMedia('(prefers-color-scheme: dark)')`; persists to `localStorage.themeMode`.
- `src/contexts/ThemeContext.jsx` — `ThemeContext` / `useIsDark()` / `useThemeMode()` hooks for components that need the theme value at runtime (e.g. for inline hex styles that can't be expressed as Tailwind classes).
- The three-button segmented control (Light / Auto / Dark) lives in `App.jsx`'s top-right settings dropdown.

**Rule: every new UI component must include dark mode from the start.** No cleanup pass — new code ships complete.

**Rule: all light-theme colors must meet WCAG 2.0 AA contrast.** Any hardcoded color used as text, icon, or border on a light background must achieve ≥4.5:1 contrast ratio against that background (≥3:1 for large text ≥18pt / bold ≥14pt). Use Tailwind 700–800 tier values for colored text on white — mid-tone 400–500 values consistently fail. Check new color constants with a contrast tool before committing. The `TAG_COLORS` array in `src/utils/colors.js` is the reference example of compliant values.

**Enforced by lint:** The ESLint rule `local/no-low-contrast-text` (defined in `eslint-rules/no-low-contrast-text.js`) flags any bare (light-mode) Tailwind `text-{color}-300` or `text-{color}-400` class in JSX `className` attributes and blocks the build. Fix by raising to `-600` and pairing with a `dark:` override:
```jsx
// ✗ FAILS lint (and WCAG)
className="text-gray-400 dark:text-gray-500"

// ✓ Passes lint
className="text-gray-600 dark:text-gray-400"
```
Exception: shades 100–200 are not flagged because they are routinely used as near-white text on dark/colored button backgrounds (`bg-gray-900 text-gray-100`). Use them only in that context.

**Common patterns:**
```jsx
// Container cards
className="bg-white border border-gray-200 dark:bg-gray-800 dark:border-gray-700"

// Body text
className="text-gray-900 dark:text-white"          // headings
className="text-gray-500 dark:text-gray-400"       // secondary text

// Form inputs
className="border border-gray-200 bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"

// Table headers / dividers
className="bg-gray-50 dark:bg-gray-700/50"
className="divide-y dark:divide-gray-700"

// Status badges
className="bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300"
className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
className="bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"

// Secondary buttons
className="bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"

// Inline hex colors — use useIsDark() from ThemeContext
const isDark = useIsDark();
style={{ color: isDark ? AP_COLORS_DARK[i] : AP_COLORS[i] }}
```

## No Duplicate Code

Before writing any utility function, helper, constant, or component — **search first**. If equivalent logic already exists, use or extend it. Only create something new when nothing suitable exists.

**Known shared utilities in `src/utils/` and `src/hooks/`:**
- `utils/formatters.js` — `formatDate`, `formatDateOnly`, `formatDurationSeconds`, `formatDurationMs`, `formatRelativeTime`, `formatCompactNumber`, `formatValue`, `computeHistoryDiffs`, `friendlyLabel`
- `utils/colors.js` — `TAG_COLORS`, AP color palettes, `getAccessPackageColor`, `TYPE_COLORS`
- `utils/accessPackageStyles.js` — `ASSIGNMENT_TYPE_STYLES` badge classes
- `utils/attributeEntries.js` — `buildAttributeEntries` (merges core + extendedAttributes)
- `utils/tierStyles.js` — `TIER_STYLES` (risk tier colors) and `tierClass(tier)` helper
- `utils/exportToExcel.js` / `utils/exportAccessPackagesToExcel.js` — Excel export logic
- `auth/useAuth.js` — `useAuth()` hook and `AuthContext`
- `hooks/useEntityPage.js` — search, filter, tags, and pagination for list pages
- `hooks/useDebouncedValue.js` — `useDebouncedValue(value, delay)` hook
- `components/ConfidenceBar.jsx` — correlation confidence bar
- `components/DetailSection.jsx` — `Section` and `CollapsibleSection` for detail pages

If the same logic already exists in one file and you're about to write it in a second, stop and extract it instead. Three or more files with the same code is a mandatory extraction — don't leave it for later.

## Key UI Behaviors

**Matrix view:**
- Staircase sort: rows grouped by leftmost AP bucket; unmanaged groups at bottom. Custom drag order persists via versioned localStorage. Bump `ROW_ORDER_VERSION` in `useMatrixRowOrder.js` when changing default sort logic.
- Owner rows: `(Owner)` rows are separate from D/I/E rows. Synthetic rows use `id: groupId__owner` with `realGroupId` pointing to the original group.
- AP column order: sorted by category name, then by assignment count within category; uncategorized APs at the end.

**Entity detail pages:**
- Three-region layout: Attributes table (left) + radial relationship graph (right).
- Hash-based routing: `#user:id`, `#group:id`, `#access-package:id`, `#identity:id`.
- Recent changes panel backed by `_history` audit table; endpoint: `GET /api/<kind>/:id/recent-changes?sinceDays=30`.

**Contexts tab (v6):** Replaces the former Org Chart tab. Manager-hierarchy trees now come from the `manager-hierarchy` context-algorithm plugin.

**Dashboard Trends tab:** Daily snapshots written by the scheduler to `DashboardSnapshots`. Charts are hand-rolled SVG via `components/TimeSeriesChart.jsx` — no chart library dependency. See [`docs/architecture/dashboard-trends.md`](../../docs/architecture/dashboard-trends.md).

## Component Structure

| Component | Purpose |
|-----------|---------|
| `App.jsx` | Root component, tab navigation, userLimit state |
| `auth/AuthGate.jsx` | MSAL authentication gate |
| `components/MatrixView.jsx` | Main matrix orchestrator |
| `components/matrix/SortableMatrixBody.jsx` | Lazy-loaded DnD + virtual scrolling wrapper |
| `components/matrix/MatrixCell.jsx` | Individual cell (AP-colored bg, multi-type badges) |
| `components/DashboardPage.jsx` | Landing page — Overview / Trends tabs |
| `components/DashboardTrendsTab.jsx` | Lazy-loaded; renders the time-series charts |
| `components/TimeSeriesChart.jsx` | Reusable hand-rolled SVG line chart (no chart lib dep) |
| `hooks/useMatrixRowOrder.js` | Row order persistence (versioned localStorage) |
| `hooks/useEntityPage.js` | Shared hook for Users/Resources pages |
