// Identity Atlas — the effective account-linking dictionary.
//
// A tenant's `AccountLinkingConfig.rules` is an *override* of the shipped
// `DEFAULT_RULES`, never a replacement of it. Saving the settings persists the
// whole JSON the editor was showing — moving the certainty slider is enough —
// so a top-level merge of the saved row over the defaults let the saved
// `signals` array shadow the shipped one wholesale: a tenant that had ever
// pressed Save was frozen on the signals of the build it saved on, and every
// signal shipped afterwards was inert for them with nothing to show it was
// missing (#1469). Linking still completed; the account it should have matched
// simply stayed orphaned.
//
// So `signals` is merged **by name** instead:
//
//   - a signal the saved dictionary lacks is added with its shipped definition;
//   - a signal it has is kept exactly as the tenant saved it — verbatim, field
//     for field, so nothing they set is overwritten;
//   - a signal the tenant invented is kept and appended.
//
// Deleting a signal from the JSON therefore does not disable it. **Weight 0 is
// the off-switch** — it is a per-signal opt-out the tenant keeps across every
// upgrade, which is why merging shipped signals back in never takes a choice
// away from them. (`accountTypeRules` has no such per-entry off-switch, so it is
// deliberately left on shallow semantics: re-adding a pattern a tenant removed
// would silently reclassify their accounts with no way to refuse it.)
//
// Order matters as well as membership. `strongestNameRung` breaks equal weights
// by position in the list, so appending the missing signals would make the
// precedence of a tie depend on *when* a signal shipped. The merged array
// follows the shipped `DEFAULT_RULES` ladder with the tenant's values
// substituted in place, so that ladder is the fixed precedence; tenant-only
// signals follow it, in the order they were saved. See
// `docs/architecture/account-linking.md` → "The effective dictionary".

import { DEFAULT_RULES } from './defaultRules.js';

/** True for a saved entry that claims the shipped signal called `name`. */
const claims = (entry, name) => entry?.name === name;

/**
 * The signals a run uses: the shipped ladder with the tenant's definitions
 * substituted in place, then the signals only the tenant has.
 *
 * A saved value that is not an array (absent, null, or malformed) means the
 * tenant stated nothing about signals, so the shipped list stands. A saved
 * *empty* array states no signal survives their edits — which is a list missing
 * every shipped signal, and so gains all of them back; a tenant switches signals
 * off by weight, not by deletion.
 */
function mergeSignals(saved) {
  if (!Array.isArray(saved)) return DEFAULT_RULES.signals;
  const shipped = DEFAULT_RULES.signals.flatMap((sig) => {
    const tenants = saved.filter((entry) => claims(entry, sig.name));
    return tenants.length ? tenants : [sig];
  });
  const shippedNames = new Set(DEFAULT_RULES.signals.map((s) => s.name));
  const tenantOnly = saved.filter((entry) => !shippedNames.has(entry?.name));
  return [...shipped, ...tenantOnly];
}

/**
 * The dictionary every linking run, the orphaned-accounts classification and the
 * settings editor must all see: the shipped defaults with a tenant's saved rules
 * merged in — `signals` by name (see above), every other key shallow, so a
 * stored `linkThreshold` / `onlyLinkTypes` / `allowNameOnlyLinks` /
 * `accountTypeRules` replaces the shipped one as it always has.
 *
 * Idempotent: merging an already-merged dictionary returns the same dictionary,
 * which is what makes it safe for the config endpoint to serve — the editor can
 * save back exactly what it was shown.
 *
 * @param {object|null|undefined} saved `AccountLinkingConfig.rules`, or nothing
 *   for an install that has never saved its settings
 * @returns {object} the effective rule set
 */
export function effectiveLinkingRules(saved) {
  if (!saved || typeof saved !== 'object') return DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...saved, signals: mergeSignals(saved.signals) };
}
