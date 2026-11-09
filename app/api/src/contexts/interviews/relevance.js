// Context interviews — how much a claim matters for identity and access governance.
//
//   relevanceOf(claim)     → 'high' | 'low'
//   withRelevance(claims)  → the claims with `relevance` set (new objects)
//
// An interview is a conversation: next to who works on what it carries small
// talk and facts that are true but change nothing about access ("the office has
// a nice canteen"). The review list shows the high tier first and folds the low
// one away, with "Reject all less relevant" for it. Fixed rules, the model's own
// tier only where the rules have nothing to say:
//
//   role, roleHistory, membership, alias   always high — who has (had) a role in it,
//                                          who joined or left, what else it is
//                                          called: the facts access review runs on
//   property   high when its attribute or value names something that affects
//              access (TERM_RE: sector, contract, customer since, regulation,
//              systems / applications used, data, vendor, hosting, location of
//              the work); else the model's tier; else low
//   description  the model's tier, else high when it names such a term, else low
//
// Pure.

// activity, expertise, duty: what a person does, knows and holds is why they need access.
const ALWAYS_HIGH = new Set(['role', 'roleHistory', 'membership', 'alias', 'activity', 'expertise', 'duty']);

// Words that make a fact matter for who should have access to what, matched
// case-insensitively in the attribute name and the value. The first group are
// stems, matched at the start of a word ("regulat" → regulated, regulation;
// "customer" → customerSince); the second are short words matched only whole
// (a stem "app" would take "appreciate").
const TERM_RE = /(?:^|[^\p{L}\p{N}])(?:sector|industr|branche|contract|customer|klant|client|regulat|complian|gdpr|nis2|hipaa|audit|certif|licen|system|applicat|software|platform|vendor|leverancier|supplier|hosting|cloud|saas|privacy|confidential|access|account|permission|admin|owner|department|afdeling|location|country|outsourc|partner|external|contractor|(?:app|apps|avg|iso|sox|dora|data|tool|tools|role|roles|team|site|region)(?![\p{L}\p{N}]))/iu;

/** Does the text name something that affects access? */
export function namesAccessTerm(text) {
  // An attribute name in camelCase is words too: mainContractor → main Contractor.
  return TERM_RE.test(String(text ?? '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2'));
}

const modelTier = (c) => (c.relevance === 'high' || c.relevance === 'low' ? c.relevance : null);

export function relevanceOf(claim) {
  if (ALWAYS_HIGH.has(claim.claimKind)) return 'high';
  if (claim.claimKind === 'property' && namesAccessTerm(`${claim.attribute ?? ''} ${claim.value ?? ''}`)) return 'high';
  const said = modelTier(claim);
  if (said) return said;
  return claim.claimKind === 'description' && namesAccessTerm(claim.value) ? 'high' : 'low';
}

export function withRelevance(claims) {
  return claims.map(c => ({ ...c, relevance: relevanceOf(c) }));
}
