// Pure helpers for EntityTimeline: the category filter, and folding a burst of
// like events (a list upload adding 40 people) into one line. Only a unit's
// timeline carries `category` and `burst` (GET /contexts/:id/timeline,
// contexts/timeline/unitEvents.js); the other entities' timelines pass through.

export const CATEGORY_LABELS = Object.freeze({ people: 'People', roles: 'Roles', structure: 'Structure', knowledge: 'Knowledge' });
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
const CATEGORY_NOUNS = { people: ['person', 'people'], roles: ['role', 'roles'], structure: ['structure', 'structure'], knowledge: ['knowledge', 'knowledge'] };

// A burst folds from this many like events in one day.
export const BURST_MIN = 4;

/** The categories the events carry, in a fixed order; [] when none does. */
export function categoriesIn(events) {
  const seen = new Set((events || []).map(e => e.category).filter(Boolean));
  return CATEGORY_ORDER.filter(c => seen.has(c));
}

/** The events whose category is not hidden (an event without one is never hidden). */
export function withoutHidden(events, hidden) {
  if (!hidden?.size) return events || [];
  return (events || []).filter(e => !e.category || !hidden.has(e.category));
}

/** "12 people · 1 roles"-style day label, by category; null when no event has one. */
export function categoryDayLabel(events) {
  const counts = new Map();
  for (const e of events) if (e.category) counts.set(e.category, (counts.get(e.category) || 0) + 1);
  if (counts.size === 0) return null;
  return CATEGORY_ORDER.filter(c => counts.has(c)).map(c => {
    const n = counts.get(c);
    const [one, many] = CATEGORY_NOUNS[c];
    return c === 'structure' || c === 'knowledge' ? `${n} ${one}` : `${n} ${n === 1 ? one : many}`;
  }).join(' · ');
}

/** What a folded burst says: "12 people joined (list upload)". */
export function burstLabel(burst, n) {
  return `${n} ${n === 1 ? burst.one : burst.many}${burst.actor ? ` (${burst.actor})` : ''}`;
}

/**
 * One day's events as lines: an event, or a burst — at least BURST_MIN events
 * with the same burst key, shown at the place of the first of them.
 * Returns [{ kind: 'event', event } | { kind: 'burst', key, label, events }].
 */
export function foldBursts(events, min = BURST_MIN) {
  const groups = new Map();
  for (const e of events) {
    if (!e.burst?.key) continue;
    if (!groups.has(e.burst.key)) groups.set(e.burst.key, []);
    groups.get(e.burst.key).push(e);
  }
  const lines = [];
  const placed = new Set();
  for (const e of events) {
    const group = e.burst?.key ? groups.get(e.burst.key) : null;
    if (!group || group.length < min) { lines.push({ kind: 'event', event: e }); continue; }
    if (placed.has(e.burst.key)) continue;
    placed.add(e.burst.key);
    lines.push({ kind: 'burst', key: e.burst.key, label: burstLabel(e.burst, group.length), events: group });
  }
  return lines;
}
