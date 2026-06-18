// Resolution policies for the effective-access engine.
//
// The engine GATHERS the set of ACEs (declared grants) that apply to a (principal, capability,
// node) tuple; a ResolutionPolicy DECIDES the effective result from that set. Keeping the
// decision in a pure, per-source function is what lets one traversal serve every source — and
// what makes deny addable later (P3) without touching the traversal core. See spec §7–§9.
//
// P1 ships only `AdditiveAllow` (monotonic, grant-only). `DenyOverrides`, `NtfsCanonical`, and
// `ClosestWins` arrive in P3 when a deny-bearing crawler exists.
//
// An ACE, as seen by a policy:
//   {
//     effect:     'allow' | 'deny' | 'eligible' | 'notset',
//     distance:   integer  — 0 at the focus node, k levels up the containment tree,
//     explicit:   boolean  — true when declared AT the focus node,
//     viaGroupId: string | null — the group hop a principal reached this grant through,
//     ...passthrough fields the caller attached (resourceId, principalId, nodeId, ...)
//   }
//
// resolve(aces) -> { effective: 'allow'|'deny'|'none', decisiveAce: ACE|null, contributing: ACE[] }

/**
 * Reachability badge for an ACE. The resource carries the capability ("what"); the badge
 * carries only reachability ("how you got it"): Direct / Indirect / Eligible. See spec §9.
 * @param {object} ace
 * @returns {'Direct'|'Indirect'|'Eligible'}
 */
export function badgeForAce(ace) {
  if (!ace) return 'Indirect';
  if (ace.effect === 'eligible') return 'Eligible';
  // Direct only when the grant is declared at the focus node AND held without a group hop.
  return ace.explicit && !ace.viaGroupId ? 'Direct' : 'Indirect';
}

// Rank an allow-ACE by reachability strength so the decisive one drives the most favourable
// (most "Direct") badge: explicit+direct < explicit-via-group < inherited. Ties break on the
// closest node (smallest distance).
function allowRank(ace) {
  if (ace.explicit && !ace.viaGroupId) return 0; // Direct
  if (ace.explicit) return 1; // explicit but via a group → Indirect
  return 2; // inherited → Indirect
}

function pickDecisiveAllow(allows) {
  return allows.reduce((best, ace) => {
    if (!best) return ace;
    const r = allowRank(ace);
    const rb = allowRank(best);
    if (r !== rb) return r < rb ? ace : best;
    return ace.distance < best.distance ? ace : best;
  }, null);
}

/**
 * AdditiveAllow — monotonic, grant-only. Any `allow` makes the result allow; `deny` is ignored
 * (these sources do not express deny). `eligible` and `notset` never grant current access, so
 * they do not produce an `allow` here — eligibility is surfaced separately by the engine.
 */
export const AdditiveAllow = {
  name: 'AdditiveAllow',
  resolve(aces) {
    const allows = (aces || []).filter((a) => a.effect === 'allow');
    if (allows.length === 0) {
      return { effective: 'none', decisiveAce: null, contributing: [] };
    }
    return { effective: 'allow', decisiveAce: pickDecisiveAllow(allows), contributing: allows };
  },
};

const REGISTRY = {
  AdditiveAllow,
};

/**
 * Look up a resolution policy by name. Throws on an unknown policy so a mis-typed source
 * configuration fails loudly rather than silently resolving everything to "none".
 * @param {string} name
 */
export function getPolicy(name) {
  const policy = REGISTRY[name];
  if (!policy) {
    throw new Error(`Unknown resolution policy '${name}'. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return policy;
}

export const DEFAULT_POLICY = 'AdditiveAllow';
