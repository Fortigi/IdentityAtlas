// Organisation truth — where the Model tab's canvas cards stand, shared by
// everyone who opens it (GET/PUT /api/org-truth/canvas-layout).
//
// One document for the whole model, kept in the generic WorkerConfig key/value
// table (no schema of its own; the layout is UI state, not organisation truth):
//
//   { positions: { [cardId]: { x, y } }, updatedAt, updatedBy }
//
// A card id is the canvas box id ("e:<entity type>" or "s:<system type>"); the
// server does not interpret it beyond its length. Coordinates are rounded to
// whole pixels and bounded, so a stored layout can never hold NaN or a card a
// million screens away. An empty `positions` is the reset: every card goes back
// to the automatic layout.
import { query } from '../../db/connection.js';

export const LAYOUT_KEY = 'orgTruth.modelLayout';
export const MAX_CARDS = 1000;
export const MAX_ID_LENGTH = 300;
export const MAX_COORD = 100000;

const EMPTY = Object.freeze({ positions: {}, updatedAt: null, updatedBy: null });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;

function positionError(id, pos) {
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return `Card id "${id.slice(0, 40)}" must be 1 to ${MAX_ID_LENGTH} characters.`;
  if (!isPlainObject(pos) || !inRange(pos.x) || !inRange(pos.y)) return `Card "${id}" needs numeric x and y within ±${MAX_COORD}.`;
  return null;
}

// Returns { errors } (non-empty) or { value: { positions } } ready to store.
export function parseLayout(body) {
  if (!isPlainObject(body?.positions)) return { errors: ['The layout needs a "positions" object.'] };
  const entries = Object.entries(body.positions);
  if (entries.length > MAX_CARDS) return { errors: [`The layout holds at most ${MAX_CARDS} cards.`] };
  const errors = [];
  const positions = {};
  for (const [id, pos] of entries) {
    const error = positionError(id, pos);
    if (error) errors.push(error);
    else positions[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  return errors.length > 0 ? { errors } : { value: { positions } };
}

// A stored value that no longer parses (hand-edited, truncated) reads as no
// layout at all rather than failing the tab.
function fromRow(row) {
  if (!row) return { ...EMPTY };
  try {
    const stored = JSON.parse(row.configValue);
    const parsed = parseLayout(stored);
    if (!parsed.value) return { ...EMPTY };
    return { positions: parsed.value.positions, updatedAt: row.updatedAt ?? null, updatedBy: stored.updatedBy ?? null };
  } catch {
    return { ...EMPTY };
  }
}

export async function readLayout() {
  const r = await query(`SELECT "configValue", "updatedAt" FROM "WorkerConfig" WHERE "configKey" = $1`, [LAYOUT_KEY]);
  return fromRow(r.rows[0]);
}

export async function writeLayout(positions, actor) {
  const r = await query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue", "updatedAt") VALUES ($1, $2, now() AT TIME ZONE 'utc')
     ON CONFLICT ("configKey") DO UPDATE SET "configValue" = EXCLUDED."configValue", "updatedAt" = EXCLUDED."updatedAt"
     RETURNING "configValue", "updatedAt"`,
    [LAYOUT_KEY, JSON.stringify({ positions, updatedBy: actor })],
  );
  return fromRow(r.rows[0]);
}
