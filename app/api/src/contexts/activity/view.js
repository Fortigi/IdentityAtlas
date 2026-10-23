// Context activity — the two reads behind the Activity section.
//
//   contextActivity(db, contextId, { from, to, includeSubUnits })   one context: its people in four groups
//   activitySummary(db, contextId, { from, to })   a parent: one line per sub-unit × month (+ itself)
//
// includeSubUnits (default: on when the context has units below it) widens the
// groups to the whole subtree: the activity on the context and every unit below
// it, compared with the members of the context and every unit below it — the
// members list's "Include sub-contexts", for activity. Off, it is the rows on
// the context itself against its own members.
//
// Without from/to the period is the twelve calendar months up to the latest
// activity in scope (report.js defaultPeriod); with no activity at all the
// answer carries period null and nothing else to show.

import { UploadError } from '../upload/service.js';
import {
  loadContext, descendantsOf, latestActivityDate, activityAggregates, personMembersOf, namesOf,
} from './store.js';
import { defaultPeriod, monthsBetween, peopleGroups, childSummary, branchMap, distinctMembers } from './report.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONTHS = 120;

/** The period asked for (both ends, valid, in order, at most ten years), else null for the default. */
export function requestedPeriod({ from, to } = {}) {
  if (from === undefined && to === undefined) return null;
  const ok = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  if (!ok(from) || !ok(to)) throw new UploadError(400, 'Give the period as from and to dates (YYYY-MM-DD).');
  if (from > to) throw new UploadError(400, 'The period starts after it ends.');
  if (monthsBetween(from, to).length > MAX_MONTHS) throw new UploadError(400, 'A period is at most ten years.');
  return { from, to };
}

const TOGGLE = { true: true, 1: true, false: false, 0: false };

/** The includeSubUnits switch asked for: true, false, or null for the default. */
export function requestedSubUnits(value) {
  if (value === undefined) return null;
  if (!Object.hasOwn(TOGGLE, value)) throw new UploadError(400, 'includeSubUnits is true or false.');
  return TOGGLE[value];
}

async function contextOrThrow(db, contextId) {
  const context = await loadContext(db, contextId);
  if (!context) throw new UploadError(404, 'Context not found.');
  return context;
}

async function periodFor(db, query, contextIds) {
  return requestedPeriod(query) ?? defaultPeriod(await latestActivityDate(db, contextIds));
}

export async function contextActivity(db, contextId, query = {}) {
  const context = await contextOrThrow(db, contextId);
  const asked = requestedSubUnits(query.includeSubUnits);
  const below = asked === false ? [] : await descendantsOf(db, context.id);
  const includeSubUnits = asked ?? below.length > 0;
  const ids = includeSubUnits ? [context.id, ...below.map(d => d.id)] : [context.id];
  const head = { contextId: context.id, targetType: context.targetType, includeSubUnits };
  const period = await periodFor(db, query, ids);
  if (!period) return { ...head, period: null, months: [], groups: [] };
  const months = monthsBetween(period.from, period.to);
  const aggregates = await activityAggregates(db, ids, period.from, period.to);
  const members = distinctMembers(await personMembersOf(db, ids));
  const names = await namesOf(db,
    [...new Set(aggregates.map(a => a.identityId).filter(Boolean))],
    [...new Set(aggregates.map(a => a.principalId).filter(Boolean))]);
  const view = peopleGroups({ targetType: context.targetType, aggregates, members, names, months });
  return { ...head, period, months, ...view };
}

export async function activitySummary(db, contextId, query = {}) {
  const context = await contextOrThrow(db, contextId);
  const below = await descendantsOf(db, context.id);
  const ids = [context.id, ...below.map(d => d.id)];
  const period = below.length ? await periodFor(db, query, ids) : null;
  if (!period) return { contextId: context.id, period: null, months: [], children: [], totals: null };
  const months = monthsBetween(period.from, period.to);
  const aggregates = await activityAggregates(db, ids, period.from, period.to);
  const members = await personMembersOf(db, ids);
  const children = below.filter(d => d.parentContextId === context.id);
  const summary = childSummary({
    targetType: context.targetType, children, self: { id: context.id, displayName: context.displayName }, branchOf: branchMap(context.id, below), aggregates, members, months,
  });
  return { contextId: context.id, period, months, ...summary };
}
