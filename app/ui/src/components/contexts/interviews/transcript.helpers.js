// Context interviews — the pure parts of the transcript view (TranscriptPanel.jsx).
//
//   transcriptTurns(text)                 → the speaker turns, with their offsets
//   buildTranscriptView(text, highlights) → the turns, each cut into pieces at the
//                                           highlight boundaries
//   primaryClaimId(ids, spans)            → which claim's colour a piece shows
//   markClass(kind, status)               → the classes of a highlight
//
// The API sends each claim's span in the transcript as stored (GET …/interviews/
// :interviewId → highlights: [{ claimId, start, end }], string offsets, end
// exclusive), so nothing here searches for a quote. A turn is a line; "Name: "
// at its start is its speaker (a .vtt / .srt transcript arrives as such lines).
// Quotes may overlap and may run over a line break into the next turn: a piece
// lists every claim covering it, and a turn is cut only where some claim starts
// or ends. One pass over the turns with the highlights sorted by start, so a
// long transcript with many claims stays linear.

// "Name:" at the start of a line: 1–5 words, the first a capital, the rest
// capitalised, a number ("Speaker 2") or a name particle (van, de, der, …). A
// clock time ("10:30") or a sentence with a colon later on is no speaker.
const SPEAKER = /^\s*(\p{Lu}[\p{L}\p{M}.'’-]*(?: [\p{L}\p{M}\p{N}.'’-]+){0,4}):[ \t]+/u;
const PARTICLES = new Set(['van', 'de', 'der', 'den', 'het', 'te', 'ten', 'ter', 'von', 'zu', 'da', 'di', 'du', 'del', 'della', 'la', 'le', 'el', 'al', 'bin', 'ibn', "'t"]);
const nameWord = (w) => /^[\p{Lu}\p{N}]/u.test(w) || PARTICLES.has(w);

function speakerOf(line) {
  const m = SPEAKER.exec(line);
  return m && m[1].split(' ').every(nameWord) ? m : null;
}

/** [{ index, speaker, start, textStart, end }] — one per non-empty line; offsets into `text`. Pure. */
export function transcriptTurns(text) {
  const turns = [];
  let at = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim()) {
      const m = speakerOf(line);
      turns.push({ index: turns.length, speaker: m ? m[1] : null, start: at, textStart: at + (m ? m[0].length : 0), end: at + line.length });
    }
    at += line.length + 1;
  }
  return turns;
}

function piecesOf(text, turn, covering) {
  const points = new Set([turn.textStart, turn.end]);
  for (const h of covering) {
    points.add(Math.min(Math.max(h.start, turn.textStart), turn.end));
    points.add(Math.min(Math.max(h.end, turn.textStart), turn.end));
  }
  const cuts = [...points].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if (a === b) continue;
    pieces.push({ start: a, end: b, text: text.slice(a, b), claimIds: covering.filter(h => h.start < b && h.end > a).map(h => h.claimId) });
  }
  return pieces;
}

/**
 * The turns with their pieces: [{ …turn, pieces: [{ start, end, text, claimIds }] }].
 * A highlight outside the text, or empty, is ignored. Pure.
 */
export function buildTranscriptView(text, highlights) {
  const source = String(text ?? '');
  const sorted = (highlights || []).filter(h => h.end > h.start && h.start < source.length).sort((a, b) => a.start - b.start);
  let next = 0;
  let active = [];
  return transcriptTurns(source).map(turn => {
    while (next < sorted.length && sorted[next].start < turn.end) active.push(sorted[next++]);
    active = active.filter(h => h.end > turn.textStart);
    const covering = active.filter(h => h.start < turn.end);
    return { ...turn, pieces: piecesOf(source, turn, covering) };
  });
}

/** Of the claims covering a piece, the one with the shortest quote — the most specific — or null. Pure. */
export function primaryClaimId(ids, spans) {
  let best = null;
  for (const id of ids) {
    const s = spans.get(id);
    if (!s) continue;
    if (!best || s.end - s.start < best.len) best = { id, len: s.end - s.start };
  }
  return best?.id ?? null;
}

// One colour per kind of claim; the fill says the status: a light fill with a
// dashed underline while proposed, a solid fill once confirmed, grey and struck
// through when rejected. Every class is written out so Tailwind keeps it.
export const KIND_STYLES = {
  role: { proposed: 'bg-blue-50 decoration-blue-600 dark:bg-blue-900/30 dark:decoration-blue-300', confirmed: 'bg-blue-200 dark:bg-blue-700/60', swatch: 'bg-blue-500' },
  roleHistory: { proposed: 'bg-indigo-50 decoration-indigo-600 dark:bg-indigo-900/30 dark:decoration-indigo-300', confirmed: 'bg-indigo-200 dark:bg-indigo-700/60', swatch: 'bg-indigo-500' },
  membership: { proposed: 'bg-purple-50 decoration-purple-600 dark:bg-purple-900/30 dark:decoration-purple-300', confirmed: 'bg-purple-200 dark:bg-purple-700/60', swatch: 'bg-purple-500' },
  alias: { proposed: 'bg-teal-50 decoration-teal-600 dark:bg-teal-900/30 dark:decoration-teal-300', confirmed: 'bg-teal-200 dark:bg-teal-700/60', swatch: 'bg-teal-500' },
  property: { proposed: 'bg-amber-50 decoration-amber-600 dark:bg-amber-900/30 dark:decoration-amber-300', confirmed: 'bg-amber-200 dark:bg-amber-700/60', swatch: 'bg-amber-500' },
  description: { proposed: 'bg-emerald-50 decoration-emerald-600 dark:bg-emerald-900/30 dark:decoration-emerald-300', confirmed: 'bg-emerald-200 dark:bg-emerald-700/60', swatch: 'bg-emerald-500' },
};

const REJECTED = 'bg-gray-100 text-gray-500 line-through dark:bg-gray-700/50 dark:text-gray-400';

/** The classes of a highlight of this kind in this status. Pure. */
export function markClass(kind, status) {
  if (status === 'rejected') return REJECTED;
  const style = KIND_STYLES[kind] || KIND_STYLES.description;
  if (status === 'confirmed' || status === 'edited') return `${style.confirmed} text-gray-900 dark:text-gray-50`;
  return `${style.proposed} underline decoration-dashed decoration-2 underline-offset-2 text-gray-900 dark:text-gray-100`;
}

export const STATUS_WORDS = { proposed: 'proposed', confirmed: 'confirmed', edited: 'confirmed (edited)', rejected: 'rejected' };
