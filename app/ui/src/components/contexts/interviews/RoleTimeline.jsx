import { useState } from 'react';
import { segmentBars } from './claims.helpers';

// ─── One person's roles at this context over time ────────────────────────
// From the confirmed role and role-history claims (claims.helpers timelines()):
// the roles in time order as text — "junior (early years) → left → architect
// CCoE (now)" — and, when the interviews gave dates, a bar per dated role on a
// shared axis. A role with only a vague period ("early on") has no bar; its
// period stays in the text. `today` closes an open-ended bar (passed in for tests).

export default function RoleTimeline({ person, today }) {
  const [now] = useState(() => Date.now());
  const bars = segmentBars(person.segments, today ?? now);
  const anyBar = bars.some(Boolean);
  return (
    <li className="space-y-1" data-testid="role-timeline">
      <div className="text-sm text-gray-900 dark:text-gray-200">
        <span className="font-medium">{person.name}</span>
        <span className="text-gray-600 dark:text-gray-400">: </span>
        {person.segments.map((s, i) => (
          <span key={s.id}>
            {i > 0 && <span aria-hidden="true" className="text-gray-600 dark:text-gray-400"> → </span>}
            {s.label}{s.period && <span className="text-gray-600 dark:text-gray-400"> ({s.period})</span>}
          </span>
        ))}
      </div>
      {anyBar && (
        <div className="relative h-3 rounded bg-gray-100 dark:bg-gray-700" aria-hidden="true">
          {bars.map((b, i) => b && (
            <span key={person.segments[i].id} title={`${person.segments[i].label} ${person.segments[i].period}`}
              className="absolute top-0 h-3 rounded bg-blue-600 opacity-80 dark:bg-blue-400"
              style={{ left: `${b.left}%`, width: `${b.width}%` }} />
          ))}
        </div>
      )}
    </li>
  );
}
