import { WAYS } from './accessModel';

// The ways a role is gained (direction "in") or lost ("out"), one chip each.
// `none` is what an empty list means: the policies state that nothing does it.
export default function WayChips({ ways, direction, none = 'None' }) {
  const list = ways ?? ['Unknown'];
  if (list.length === 0) return <span className="text-xs text-gray-600 dark:text-gray-400">{none}</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map((way) => {
        const def = WAYS[direction][way] ?? WAYS[direction].Unknown;
        return (
          <span key={way} title={def.hint} className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${def.style}`}>
            {def.label}
          </span>
        );
      })}
    </span>
  );
}
