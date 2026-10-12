// Organisation knowledge extraction — how sure we are that a statement holds.
//
//   scoreStatement({ support, modality, sides, corroboration }) → { confidence, parts }   (pure)
//   bandOf(confidence)                                            → 'high' | 'medium' | 'low'
//
// 0–100, built from what we can see — never a probability:
//   the transcript      verifier verdict (a hint: measured unreliable) and modality
//   the matching        each side that should be an existing object: confirmed by a
//                       reviewer, a clear candidate, ambiguous, or nothing
//   the existing data   corroboration.js: the directory, contexts, Org Info lists or
//                       activity say the same (+30) — or the opposite (capped at 25)
// "high" (≥ HIGH) is what a reviewer can scan and accept in one click; it is
// never accepted automatically.

export const HIGH = 80;
export const MEDIUM = 50;

const SUPPORT = { supported: 60, unclear: 45, unchecked: 40, unsupported: 30 };
const MODALITY = { stated: 0, correction: -5, implied: -10, uncertain: -15, question: -25 };
const SIDE = { confirmed: 10, clear: 5, ambiguous: -5, unmatched: 0, none: 0 };
export const CORROBORATED = 30;
export const CONTRADICTED_CAP = 25;

/**
 * @param {{ support?: string, modality?: string,
 *           sides: Array<'confirmed'|'clear'|'ambiguous'|'unmatched'|'none'>,
 *           corroboration?: { verdict: 'corroborated'|'contradicted'|null } }} s
 */
export function scoreStatement({ support, modality, sides = [], corroboration = null }) {
  const parts = {
    transcript: (SUPPORT[support] ?? SUPPORT.unchecked) + (MODALITY[modality] ?? 0),
    matching: sides.reduce((n, s) => n + (SIDE[s] ?? 0), 0),
    data: corroboration?.verdict === 'corroborated' ? CORROBORATED : 0,
  };
  let confidence = parts.transcript + parts.matching + parts.data;
  if (corroboration?.verdict === 'contradicted') confidence = Math.min(confidence, CONTRADICTED_CAP);
  return { confidence: Math.max(0, Math.min(100, confidence)), parts };
}

export function bandOf(confidence) {
  if (confidence >= HIGH) return 'high';
  if (confidence >= MEDIUM) return 'medium';
  return 'low';
}
