// One piece of evidence: the exact quote, marked inside the passage it came
// from. Offsets are absolute into the source text; when the passage is not at
// hand (or the span does not fit it) the quote is shown on its own.
// Props: { evidence: { seq, startChar, endChar, quote }, passages }
import { passageFor, splitHighlight } from './knowledgeFormat';

const MARK = 'rounded bg-yellow-100 px-0.5 italic text-gray-900 dark:bg-yellow-900/40 dark:text-gray-100';

export default function EvidenceQuote({ evidence, passages }) {
  const passage = passageFor(passages, evidence);
  const parts = splitHighlight(passage, evidence.startChar, evidence.endChar);
  const seq = passage?.seq ?? evidence.seq;
  return (
    <blockquote className="border-l-2 border-gray-300 pl-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300">
      {seq != null && <span className="mr-1 text-xs text-gray-600 dark:text-gray-400">§{seq}</span>}
      {parts
        ? <>{parts.before}<mark className={MARK}>{parts.mark}</mark>{parts.after}</>
        : <mark className={MARK}>{evidence.quote}</mark>}
    </blockquote>
  );
}
