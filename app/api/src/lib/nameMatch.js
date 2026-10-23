// Matching a person's NAME to an account or person — the one place it is decided.
//
// Used by the synced-owner → Accountable resolution (ingest/contextOwners.js,
// in SQL) and by the member and owner matching of a context upload
// (contexts/upload/members.js, in JS). Both normalise a name the same way:
//
//   normalizeName("  Jansen,  Jan | Example Org ") → "jan jansen"
//     - accents dropped (Brümmel = Brummel; ø, ł, đ folded too)
//     - case ignored, whitespace trimmed and collapsed
//     - one trailing " | <org>" or " (<org>)" dropped — on both sides
//     - "Last, First" read as "First Last"
//     - dots, hyphens and underscores read as spaces (Jan-Peter = Jan Peter)
//
// normalizedNameSql(expr) is the same function as a PostgreSQL expression. The
// accent folding there is a fixed translate() table (no unaccent extension is
// installed); FOLD_FROM / FOLD_TO is that table, and nameMatch.test.js checks
// that the JS normaliser folds every one of its letters the same way.
//
// buildNameMatcher(candidates) decides a value:
//   1. normalised-equal: the ONE candidate with that name → { id, kind: 'name' };
//      preferred candidates (user accounts) first — a user "Jan Jansen" wins over
//      a service principal of the same name, two users are ambiguous.
//   2. else near miss: Jaro-Winkler on the normalised names ≥ FUZZY_THRESHOLD,
//      and at least FUZZY_MARGIN ahead of the runner-up → { id, kind: 'fuzzy' };
//      a runner-up too close is ambiguous. Never a guess.
// The fuzzy step is JS only (an upload: a list of hundreds of values). The
// ingest resolves owners for whole crawls in one statement and stops at step 1.

export const FUZZY_THRESHOLD = 0.93;
export const FUZZY_MARGIN = 0.03;

// Letters NFD does not decompose, folded by hand in JS and by translate() in SQL.
const EXTRA_FOLD = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ı': 'i' };
export const FOLD_FROM = 'àáâãäåāăąçćčďđèéêëēėęěìíîïīįıłñńňòóôõöøōőŕřśšşťùúûüūůűųýÿźżž';
export const FOLD_TO = 'aaaaaaaaacccddeeeeeeeeiiiiiiilnnnoooooooorrssstuuuuuuuuyyzzz';

const SUFFIX = /\s*(?:\|[^|]*|\([^()]*\))\s*$/u;
const LAST_FIRST = /^([^,]+),\s*([^,]+)$/u;

/** A name in the one form two spellings of it share; '' for nothing. */
export function normalizeName(value) {
  const folded = String(value ?? '')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øłđı]/g, ch => EXTRA_FOLD[ch])
    .trim();
  return folded
    .replace(SUFFIX, '')
    .replace(LAST_FIRST, '$2 $1')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** normalizeName as a PostgreSQL expression over `expr` (a column or a value). */
export function normalizedNameSql(expr) {
  const folded = `translate(lower(btrim(${expr})), '${FOLD_FROM}', '${FOLD_TO}')`;
  const noSuffix = `regexp_replace(${folded}, '\\s*(\\|[^|]*|\\([^()]*\\))\\s*$', '')`;
  const swapped = `regexp_replace(${noSuffix}, '^([^,]+),\\s*([^,]+)$', '\\2 \\1')`;
  return `btrim(regexp_replace(regexp_replace(${swapped}, '[._-]+', ' ', 'g'), '\\s+', ' ', 'g'))`;
}

// ─── Jaro-Winkler ────────────────────────────────────────────────────────
function jaroMatches(a, b) {
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const used = new Array(b.length).fill(false);
  const fromA = [];
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (used[j] || a[i] !== b[j]) continue;
      used[j] = true;
      fromA.push(a[i]);
      break;
    }
  }
  const fromB = [...b].filter((_, j) => used[j]);
  return { fromA, fromB };
}

/** Jaro-Winkler similarity, 0..1 (1 = equal). Prefix scale 0.1, up to four letters. */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const { fromA, fromB } = jaroMatches(a, b);
  const m = fromA.length;
  if (m === 0) return 0;
  let transposed = 0;
  for (let k = 0; k < m; k++) if (fromA[k] !== fromB[k]) transposed++;
  const jaro = (m / a.length + m / b.length + (m - transposed / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] !== undefined && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ─── The matcher ─────────────────────────────────────────────────────────
// The preferred candidates when there are any, else all of them.
const tier = (list) => {
  const preferred = list.filter(c => c.preferred);
  return preferred.length ? preferred : list;
};

function exactMatch(list) {
  const ids = new Set(tier(list).map(c => c.id));
  return ids.size === 1 ? { id: [...ids][0], kind: 'name' } : { ambiguous: true };
}

function fuzzyMatch(norm, candidates) {
  const scored = candidates.map(c => ({ c, score: jaroWinkler(norm, c.norm) }));
  const close = scored.filter(s => s.score >= FUZZY_THRESHOLD);
  if (close.length === 0) return null;
  const pool = close.some(s => s.c.preferred) ? scored.filter(s => s.c.preferred) : scored;
  pool.sort((x, y) => y.score - x.score);
  const [best, runnerUp] = pool;
  if (runnerUp && best.score - runnerUp.score < FUZZY_MARGIN) return { ambiguous: true };
  return { id: best.c.id, kind: 'fuzzy', matchedName: best.c.name, score: Math.round(best.score * 1000) / 1000 };
}

/**
 * @param {Array<{id: *, name: string, preferred?: boolean}>} candidates
 * @returns {(value: string) => ({id, kind: 'name'|'fuzzy', matchedName?, score?}|{ambiguous: true}|null)}
 */
export function buildNameMatcher(candidates) {
  const byNorm = new Map();
  const all = [];
  const seen = new Set();
  for (const c of candidates) {
    const norm = normalizeName(c.name);
    if (!norm || seen.has(c.id)) continue;
    seen.add(c.id);
    const entry = { id: c.id, name: c.name, norm, preferred: !!c.preferred };
    all.push(entry);
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(entry);
  }
  return (value) => {
    const norm = normalizeName(value);
    if (!norm) return null;
    const exact = byNorm.get(norm);
    return exact ? exactMatch(exact) : fuzzyMatch(norm, all);
  };
}
