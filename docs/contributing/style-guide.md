# UI Style Guide

The single source of truth for how the Identity Atlas UI looks and behaves. Every UI PR should follow it; parts of it are enforced in CI (see [Enforcement](#enforcement)). It exists because an audit found the UI had a healthy *token* layer but no shared *component* layer or written conventions, so the same control drifted across colours, confirmations, and dark-mode coverage.

---

## 1. Colour system — two roles

Identity Atlas uses **two** accent colours with distinct, non-overlapping jobs. Don't mix them, and don't introduce a third (no indigo / emerald / teal for primary actions).

| Role | Colour | Use for | Light | Dark |
|---|---|---|---|---|
| **Brand / identity** | Green | Logo, active nav tab, section/heading accents, the docs site | brand `#65b425`; text/links `lime-700` (`#4d7c0f`) for contrast | `lime-400` |
| **Interactive** | Blue | Primary buttons, links, toggles, selected controls, focus ring | `blue-600` (hover `blue-700`) | `blue-700` (hover `blue-600`) |

Rationale: green is who we *are* (it echoes the logo); blue is what you *click*. The brand green is bright, so use the darker `lime-700` for any green **text** on white to meet contrast — reserve `#65b425` for the logo and large/bold accents.

### Status colours (semantic — keep consistent)
| Meaning | Classes |
|---|---|
| Success | `bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300` |
| Warning | `bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300` |
| Danger | `bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300` |
| Info | `bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300` |

### Domain palettes (don't re-invent — import these)
- `utils/colors.js` — `TYPE_COLORS` (membership-type badges D/I/E/O/G/A/R), `AP_COLORS`/`AP_COLORS_DARK` + `getAccessPackageColor`, `TAG_COLORS`.
- `utils/tierStyles.js` — risk-tier styles (the reference for a complete light+dark token set).
- `utils/accessPackageStyles.js` — assignment-policy badges.
- `utils/contextStyles.js` — context variant/target badges.

---

## 2. Dark mode (hard rule)

**Every component ships dark mode from the start** — no cleanup pass later.

- Every colour utility needs a `dark:` counterpart: `bg-white dark:bg-gray-800`, `text-gray-900 dark:text-white`, `border-gray-200 dark:border-gray-700`.
- Style **maps/constants** (badge colour objects) must include `dark:` on every entry — they're applied raw, so a missing one breaks the whole surface. Guard them with a small test (see `contextStyles.test.js`).
- **Inline hex** (`style={{ color: '#…' }}`) is not theme-aware — avoid it for text; if unavoidable, switch on `useIsDark()`.

## 3. Accessibility (WCAG 2.1 AA)

- **Contrast:** coloured text on white uses the **700–800** tier (mid-tone 300–500 fail). Enforced by `local/no-low-contrast-text`.
- **Real controls:** anything clickable is a `<button>`/`<a>` — never `<div onClick>` (no keyboard/role). Icon-only buttons need `aria-label`.
- **Forms:** associate every `<label>` with its input (`htmlFor` + `id`), ideally via the shared `Field`.
- **Focus & motion:** a global `:focus-visible` ring and `prefers-reduced-motion` support live in `index.css`; don't strip focus outlines. A skip-to-content link is in `App.jsx`.

## 4. Components & interaction patterns

- **Reuse before creating** (repo rule): search for an existing component/util first; 3+ copies of the same markup is a mandatory extraction. Shared primitives live alongside the features today (`contexts/ModalPrimitives.jsx`, `DetailSection.jsx`, `EmptyState.jsx`) and are migrating into a shared set.
- **No native dialogs.** Never use `window.confirm` / `alert` / `prompt` — they're unstyled, not dark-mode aware, and untestable. Use an in-app confirm/toast. Enforced by `local/no-native-dialogs`.
- **Feedback:** prefer inline messages / a toast over blocking dialogs. Loading/empty/error states should be explicit and, for empty states, offer a next step (`EmptyState` with a CTA).
- **Buttons:** one primary style (blue). Don't hand-roll new colour/size combos.

## 5. Terminology (glossary)

Use the left column in all user-facing text. Banned terms are enforced by `local/no-legacy-jargon`.

| Use this | Not this | Notes |
|---|---|---|
| **Business Role** | "Access Package" (as a separate thing) | Same concept; "Access Package" is the Entra source name — gloss once if needed |
| **Governed / Non-governed** | **SOLL / IST** | German governance jargon — never in the UI |
| **Context** | "OU" / "Org Unit" | Contexts replaced OrgUnits in v6 |
| **Users** | bare "Principal" in UI chrome | "Principal" is the data-model term; gloss it when shown |
| **Resource** | "Group" (in icons/types) | Groups are one kind of resource |
| Membership types | unlabelled letters | D Direct · I Indirect · E Eligible · O Owner · G Governed · A OAuth2 · R App-role (always provide the matrix legend) |

## 6. Typography & spacing

- Prefer the Tailwind type scale (`text-xs/sm/base/lg`) over arbitrary `text-[Npx]` values.
- Buttons: small `px-3 py-1.5`, default `px-4 py-2`. Cards: `rounded-lg p-4` with `ring-1`/`border` + the surface/border tokens above.

---

## Enforcement

CI runs these on every PR (the `Lint: ESLint` + `PR Hygiene` checks in [the PR pipeline](../architecture/branching-strategy.md)):

| Rule | Level | Catches |
|---|---|---|
| `local/no-low-contrast-text` | error | bare light-mode `text-{color}-300/400` |
| `local/no-native-dialogs` | error (allowlisted legacy files: warn) | `confirm()` / `alert()` / `prompt()` |
| `local/no-legacy-jargon` | error | "SOLL", "IST", "Org Unit", "Start-FGSync" in UI strings |
| **PR Hygiene** | error | a UI/source change with no test, or no `changes/` changelog fragment |

`no-native-dialogs` carries a **shrinking allowlist** of files that still use native dialogs (the pre-existing backlog). As each is migrated to an in-app dialog, remove it from the allowlist — new code is gated immediately.
