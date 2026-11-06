import { KNOWLEDGE_KINDS, KIND_LABELS, knowledgeCounts, knowledgeName, subjectLabel } from './claims.helpers';

// ─── What we know: what the unit's people do, know and hold ──────────────
// The confirmed activity, expertise and duty claims about its people — the same
// ones the Authorization workbench shows as columns — by kind: who, what, and the
// source (with the unit it was added on, when that is another one). Nothing when
// none are confirmed. `Quote` is What we know's own source line.

const HEADINGS = { activity: 'Activities', expertise: 'Expertise', duty: 'Duties' };

export default function PeopleKnowledge({ grouped, unitName, Quote }) {
  const counts = knowledgeCounts(grouped);
  if (!counts) return null;
  return (
    <div data-testid="people-knowledge">
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">What its people do, know and hold <span className="font-normal text-gray-600 dark:text-gray-400">· {counts}</span></h4>
      {KNOWLEDGE_KINDS.filter(k => grouped[k].length > 0).map(k => (
        <div key={k} className="mt-1">
          <h5 className="text-xs text-gray-600 dark:text-gray-400">{HEADINGS[k]}</h5>
          <ul className="text-sm">
            {grouped[k].map(c => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2" aria-label={`${KIND_LABELS[k]}: ${subjectLabel(c)} — ${knowledgeName(c)}`}>
                <span className="text-gray-700 dark:text-gray-300">{subjectLabel(c)}</span>
                <span className="text-gray-900 dark:text-gray-100">{knowledgeName(c)}</span>
                {c.status === 'edited' && <span className="text-xs text-gray-600 dark:text-gray-400">(edited)</span>}
                {c.filedUnderName && c.filedUnderName !== unitName && (
                  <span className="text-xs text-gray-600 dark:text-gray-400">added on {c.filedUnderName}</span>
                )}
                <Quote claim={c} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
