# React UI — Coding Guide

## Dark Mode

The UI supports a light/dark theme toggle via Tailwind v4's class-based dark mode.

**How it works:**
- `index.css` declares `@custom-variant dark (&:is(.dark, .dark *))` — the `dark` class on `<html>` activates all `dark:` variants.
- `src/hooks/useTheme.js` — three-state machine (`'light' | 'auto' | 'dark'`); `'auto'` follows the OS via `matchMedia('(prefers-color-scheme: dark)')`; persists to `localStorage.themeMode`.
- `src/contexts/ThemeContext.jsx` — `ThemeContext` / `useIsDark()` / `useThemeMode()` hooks for components that need the theme value at runtime (e.g. for inline hex styles that can't be expressed as Tailwind classes).
- The three-button segmented control (Light / Auto / Dark) lives in `App.jsx`'s top-right settings dropdown.

**Rule: every new UI component must include dark mode from the start.** No cleanup pass — new code ships complete.

**Rule: all light-theme colors must meet WCAG 2.0 AA contrast.** Any hardcoded color used as text, icon, or border on a light background must achieve ≥4.5:1 contrast ratio against that background (≥3:1 for large text ≥18pt / bold ≥14pt). Use Tailwind 700–800 tier values for colored text on white — mid-tone 400–500 values consistently fail. Check new color constants with a contrast tool before committing. The `TAG_COLORS` array in `src/utils/colors.js` is the reference example of compliant values. For a pill/chip whose colour comes from **data** (a tag or category hex you don't control), don't hand-roll `{ backgroundColor: color + '20', color }` — that draws the raw colour as text and fails contrast (badly in dark mode). Use `tagPillStyle(hex, useIsDark())` from `utils/colors.js`, which tints the background and nudges the text to clear AA for the active theme.

**Enforced by lint:** The ESLint rule `local/no-low-contrast-text` (defined in `eslint-rules/no-low-contrast-text.js`) flags any bare (light-mode) Tailwind `text-{color}-300` or `text-{color}-400` class in JSX `className` attributes and blocks the build. Fix by raising to `-600` and pairing with a `dark:` override:
``jsx
// ✗ FAILS lint (and WCAG)
className="text-gray-400 dark:text-gray-500"

// ✓ Passes lint
className="text-gray-600 dark:text-gray-400"
``
Exception: shades 100–200 are not flagged because they are routinely used as near-white text on dark/colored button backgrounds (`bg-gray-900 text-gray-100`). Use them only in that context.

**Common patterns:**
``jsx
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
``

## Import path aliases

All cross-directory imports inside `src/` **must** use the `@ui/` alias rather than relative `'../'` traversal. Same-folder imports (`'./'`) are fine.

| Alias | Resolves to | Use for |
|-------|------------|---------|
| `@ui/X` | `app/ui/src/X` | Anything in `src/` referenced from within `src/` or from `tools/crawlers/` |
| `@crawlers/X` | `tools/crawlers/X` | Crawler plugins referenced from within `tools/crawlers/` |

``js
// ✓ Correct — use @ui/ alias
import { useAuth } from '@ui/auth/AuthGate';
import { formatDate } from '@ui/utils/formatters';
import Stepper from '@ui/components/Stepper';

// ✗ Wrong — relative traversal
import { useAuth } from '../../auth/AuthGate';
import { formatDate } from '../../../app/ui/src/utils/formatters';
``

**Enforcement:** The ESLint rule `local/no-relative-package-imports` (in `eslint-rules/no-relative-package-imports.js`) blocks `'../'` imports in `src/**` at lint time. The Vitest test `src/__tests__/import-conventions.test.js` enforces the same at test time — it also covers crawler wizard files under `tools/crawlers/`.

**Editor support:** `jsconfig.json` at the repo root maps both aliases so VS Code / WebStorm resolve them without errors.

**`import.meta.glob` exception:** Vite's `import.meta.glob()` calls in `CrawlersPage.jsx` still use relative paths (`../../../../tools/crawlers/*/...`) because glob key lookup depends on the literal string matching. Do not change these.

## No Duplicate Code

Before writing any utility function, helper, constant, or component — **search first**. If equivalent logic already exists, use or extend it. Only create something new when nothing suitable exists.

**Known shared utilities in `src/utils/` and `src/hooks/`:**
- `utils/formatters.js` — `formatDate`, `formatDateOnly`, `formatDurationSeconds`, `formatDurationMs`, `formatRelativeTime`, `formatCompactNumber`, `formatValue`, `computeHistoryDiffs`, `friendlyLabel`
- `utils/colors.js` — `TAG_COLORS`, AP color palettes, `getAccessPackageColor`, `TYPE_COLORS`, `tagPillStyle(hex, isDark)` (contrast-safe inline styles for a tag/category pill built from arbitrary hex — use this instead of `color + '20'`), `contrastRatio(a, b)` (WCAG ratio between two `{r,g,b}` colors)
- `utils/accessPackageStyles.js` — `ASSIGNMENT_TYPE_STYLES` badge classes
- `utils/attributeEntries.js` — `buildAttributeEntries` (merges core + extendedAttributes)
- `utils/tierStyles.js` — `TIER_STYLES` (risk tier colors) and `tierClass(tier)` helper
- `utils/exportToExcel.js` / `utils/exportAccessPackagesToExcel.js` — Excel export logic
- `auth/AuthGate.js` — `useAuth()` hook and `AuthContext` (component provider is `auth/AuthGateProvider.jsx`)
- `hooks/useEntityPage.js` — search, filter, tags, and pagination for list pages
- `hooks/useDebouncedValue.js` — `useDebouncedValue(value, delay)` hook
- `hooks/useFetch.js` — `useFetch(url, { authFetch, enabled?, transform?, initialData?, onError? }) → { data, loading, error, reload }`. The shared GET-fetch lifecycle (loading/error/abort-on-unmount-or-dep-change). **Prefer this over hand-rolling a `useState`+`useEffect` fetch** — it uses `useReducer` internally so it doesn't trip `react-hooks/set-state-in-effect` (a synchronous `setLoading(true)` at the top of an effect does). Use it for a single GET → single data shape; bespoke cases (multiple `Promise.all` fetches, polling, locally-mutated results) still hand-roll. `error` is an `Error` (render `error.message`).
- `components/dialogContext.js` + `components/DialogProvider.jsx` — the in-app replacement for the browser's native `alert`/`confirm`/`prompt` (which are blocked by the `local/no-native-dialogs` ESLint rule — they don't theme/dark-mode and block the thread). `DialogProvider` is mounted once at the app root (`main.jsx`); call `const dialog = useDialog()` and use its **async** API. **Never call `window.alert/confirm/prompt`.** See "In-app dialogs" below.
- `components/ConfidenceBar.jsx` — correlation confidence bar
- `components/DetailSection.jsx` — `Section` and `CollapsibleSection` for detail pages
- `components/ScheduleEditor.jsx` — one schedule-entry editor (frequency/hour/minute/day/syncMode), used by every crawler wizard's Schedule step and Risk Scoring; props: `schedule: {frequency, hour?, minute?, day?, syncMode}`, `onChange(updated)`, `onRemove()` — the component is uncontrolled-by-index, so the caller owns the schedules array and supplies one `schedule`/`onChange`/`onRemove` per entry (see `tools/crawlers/omada/ConfigWizard.jsx`'s Schedule step for the list-of-entries pattern)
- `components/inputs/Combobox.jsx` — free-text input with live-discovery dropdown; props: `value`, `onChange`, `options: string[]`, `defaultOption: {value,label}`, `placeholder`, `className`, `wrapperClassName`
- `components/inputs/Select.jsx` — styled native `<select>` with `ChevronDown` overlay; props: `value`, `onChange`, `id`, `wrapperClassName`, children as `<option>` elements
- `components/inputs/ChevronDown.jsx` — shared SVG chevron icon; used by both `Select` and `Combobox`
- `components/EntityListPage.jsx` — full list-page scaffold (header, tag bar, filter bar, action bar, table, pagination) backed by `useEntityPage`; props: `title`, `entityType`, `listEndpoint`, `columnsEndpoint`, `tagFilterKey`, `tableColumns`, `fieldLabels`, `renderEntityCell(item, onOpenDetail)`, `renderDataCells(item)`, `searchPlaceholder`, `showIncludeDeleted`, `subTabBar`, `baseFilters`, `customizeFilterFields`, `onOpenDetail`. Used by GroupsPage/UsersPage/IdentitiesPage — do not re-implement list-page boilerplate.
- `components/EntityDetailPage.jsx` — full detail-page scaffold (data fetch, loading/error guards, TabBar, Attributes/Relationships/Timeline/Risk tabs, graph via `useExpandableGraph`, timeline via `useTimeline`); extend via render props: `renderHeader(data)`, `renderAttributesBefore(data)`, `renderAttributesExtra(data)`, `renderRelationshipsExtra(data, graph)`, `renderRisk(data)`, `getTabs(data, entries)`, `getAttributeEntries(data)`. Used by ResourceDetailPage/UserDetailPage/AccessPackageDetailPage/IdentityDetailPage — do not re-implement detail-page boilerplate.
- `components/LinkedAccountsPanel.jsx` — linked accounts list with confidence bar, analyst override badges and Confirm/Remove/Undo buttons; props: `members`, `busyMember`, `onOverride(principalId, action)`, `onOpenDetail`
- `components/WizardShell.jsx` — shared outer card/header/stepper/error wrapper for all crawler ConfigWizard components; props: `title`, `onCancel`, `steps`, `currentStep`, `onStepClick`, `allowAllSteps`, `error`, `children`
- `components/MappingRows.jsx` — generic add/remove/update mapping-row grid for ConfigWizard components; props: `rows`, `onAdd`, `onRemove(i)`, `onUpdate(i,key,val)`, `columns: [{key, render(value,onChange)}]`, `headers?`, `addLabel?`, `minRows?`
- `utils/crawlerCredentials.js` — `canSubmitCredentials(authMethod, fields, isEdit)`, `buildCredentialFields(authMethod, fields)`, `SECRET_PLACEHOLDER`; covers all auth methods used by crawlers

If the same logic already exists in one file and you're about to write it in a second, stop and extract it instead. Three or more files with the same code is a mandatory extraction — don't leave it for later.

## In-app dialogs (no native `alert`/`confirm`/`prompt`)

The browser's native dialogs are **banned** — the `local/no-native-dialogs` ESLint rule fails the build on `alert()`, `confirm()`, or `prompt()`. They block the main thread and can't be themed (no dark mode). Use the shared `useDialog()` hook instead; its provider is mounted once at the app root in `main.jsx` (and in the mount-test harness `renderWithProviders`, so component tests get it for free).

```jsx
import { useDialog } from '@ui/components/dialogContext';

function MyThing() {
  const dialog = useDialog();

  async function onDelete() {
    // confirm/prompt are ASYNC — they resolve when the user acts.
    if (!(await dialog.confirm({ message: 'Delete this?', confirmLabel: 'Delete', danger: true }))) return;
    await authFetch(url, { method: 'DELETE' });
  }

  async function onRename() {
    const name = await dialog.prompt({ title: 'Rename', message: 'New name?', defaultValue: cur });
    if (!name) return;           // null = cancelled
    // ...
  }

  function onSaved() {
    dialog.toast('Saved', { variant: 'success' });   // non-blocking, auto-dismiss top-right
    dialog.alert('Something went wrong');             // alert() → an error-variant toast
  }
}
```

- `confirm(opts) → Promise<boolean>` and `prompt(opts) → Promise<string|null>` render as modals (reusing `ModalPrimitives`). Always `await` them; converting a handler that called `confirm()` means making it `async`.
- `toast(message, opts)` / `alert(message, opts)` are fire-and-forget toasts (`variant`: `info`/`success`/`error`/`warning`).
- `opts`: `message`, `title?`, `confirmLabel?`, `cancelLabel?`, `danger?` (red confirm button), `defaultValue?`/`placeholder?` (prompt), `width?`.
- **Testing**: drive the dialog like a real user — click the confirm button by its `confirmLabel`, or type into the prompt's textbox then click confirm. See `components/DialogProvider.mount.test.jsx`.

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

## Crawler Wizard Plugin System

Crawler configuration wizards are loaded from `tools/crawlers/*/ConfigWizard.jsx` via `import.meta.glob` — `CrawlersPage.jsx` contains no crawler-specific code. To add a wizard for a new crawler type, drop a `ConfigWizard.jsx` and `CrawlerMeta.js` in its folder. No changes to `CrawlersPage.jsx` are needed.

**How it works (in `CrawlersPage.jsx`):**

``js
// Eager-load all CrawlerMeta.js files for the type picker
const _crawlerMetaModules = import.meta.glob('../../../../tools/crawlers/*/CrawlerMeta.js', { eager: true });
const _discoveredCrawlerTypes = Object.values(_crawlerMetaModules).map(m => ({ ...m.default, available: true }));

// Lazy-load ConfigWizard.jsx on demand (code-split per crawler)
const _wizardModules = import.meta.glob('../../../../tools/crawlers/*/ConfigWizard.jsx');
function getCrawlerWizard(crawlerType) {
  const loader = _wizardModules[`../../../../tools/crawlers/${crawlerType}/ConfigWizard.jsx`];
  return loader ? lazy(loader) : null;
}

// Eager-load optional Summary.jsx panels for the configured-crawlers card
const _summaryModules = import.meta.glob('../../../../tools/crawlers/*/Summary.jsx', { eager: true });
function getCrawlerSummary(crawlerType) {
  return _summaryModules[`../../../../tools/crawlers/${crawlerType}/Summary.jsx`]?.default || null;
}
``

**Vite dev server:** `vite.config.js` sets `server.fs.allow` to include the repo root so wizard components under `tools/crawlers/` are served correctly during development. This is already configured — don't remove it.

**Production builds:** this glob is resolved against the literal filesystem at build time, so any pipeline that bundles the UI for production (Docker, the portable node-launcher build, ...) must stage `tools/crawlers/` as a true sibling of `app/ui/` with a shared `node_modules` — not just copy `app/ui/`. See `docs/architecture/crawler-architecture.md` → "UI Wizard Plugins and Production Build Pipelines" for why, and for the list of pipelines that already do this correctly.

**Wizard component contract:** see `tools/crawlers/CLAUDE.md` → UI Integration for the props interface.

**Rule: nothing crawler-specific lives in `app/ui/`.** Not just the wizard/discover/summary files — a new crawler's tests (unit, render-smoke, e2e) and any helper belong in its `tools/crawlers/<type>/` folder too, even a test file that would otherwise naturally land in `app/ui/e2e/`. See `tools/crawlers/CLAUDE.md` → Rules and → JS/UI Testing. CI partially enforces this (`crawler-manifest` job flags stray filenames/hardcoded type strings) but don't rely on it — get it right the first time.

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

## App-shell routing & the JSX coverage blind spot

`App.jsx` dispatches the top nav to page components through `src/pageRegistry.jsx` — a `{ pageKey: (ctx) => <Page … /> }` map resolved by `resolvePageRoute(page)`. **Add, rename, or reorder a static page there** (a one-line data edit), not in a JSX conditional in `App.jsx`. `ctx` carries the shared handlers (`navigate`, `openDetailTab`, `forceRefresh`, `riskScoresRefreshKey`, `onRiskScoresRefresh`); cover new entries in `pageRegistry.test.jsx`.

Why a map and not the old inline `page === 'x' ? <X/> : …` chain: **v8 does not line-instrument the arms of a JSX ternary**, so those lines carried no coverage record and every routing edit tripped the (non-blocking) `Diff coverage: UI` gate on an un-coverable line ([#669](https://github.com/Fortigi/IdentityAtlas/issues/669)). Map entries + render-function statements are ordinary instrumented code the registry test covers.

**Accepted exception — pure-JSX page shells.** The same v8 limitation applies to components that are mostly one big JSX `return`: the matrix views, the `EntityDetailPage`/`EntityListPage`-based pages (`UsersPage`, detail pages, …), and the detail-tab dispatch + matrix fallback that stay in `App.jsx`. Splitting them into more files does **not** make their JSX instrumentable, so they are covered by e2e (`app/ui/e2e/*.spec.js`), and a `Diff coverage: UI` red on such a file's JSX body is expected — confirm the e2e exercises the behaviour rather than chasing the line. Formalising a `diff_cover` exclude for this set is tracked in [#725](https://github.com/Fortigi/IdentityAtlas/issues/725).
