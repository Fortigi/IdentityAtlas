// Context activity — the two reads behind the Activity section.
//
//   contextActivity(db, contextId, { from, to })   one context: its people in four groups
//   activitySummary(db, contextId, { from, to })   a parent: one line per sub-unit × month
//
// Without from/to the period is the twelve calendar months up to the latest
// activity in scope (report.js defaultPeriod); with no activity at all the
// answer carries period null and nothing else to show.

import { UploadError } from '../upload/service.js';
import {
  loadContext, descendantsOf, latestActivityDate, activityAggregates, personMembersOf, namesOf,
} from './store.js';
import { defaultPeriod, monthsBetween, peopleGroups, childSummary, branchMap } from './report.js';

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
  const period = await periodFor(db, query, [context.id]);
  if (!period) return { contextId: context.id, targetType: context.targetType, period: null, months: [], groups: [] };
  const months = monthsBetween(period.from, period.to);
  const aggregates = await activityAggregates(db, [context.id], period.from, period.to);
  const members = await personMembersOf(db, [context.id]);
  const names = await namesOf(db,
    [...new Set(aggregates.map(a => a.identityId).filter(Boolean))],
    [...new Set(aggregates.map(a => a.principalId).filter(Boolean))]);
  const view = peopleGroups({ targetType: context.targetType, aggregates, members, names, months });
  return { contextId: context.id, targetType: context.targetType, period, months, ...view };
}

export async function activitySummary(db, contextId, query = {}) {
  const context = await contextOrThrow(db, contextId);
  const below = await descendantsOf(db, context.id);
  const ids = below.map(d => d.id);
  const period = ids.length ? await periodFor(db, query, ids) : null;
  if (!period) return { contextId: context.id, period: null, months: [], children: [], totals: null };
  const months = monthsBetween(period.from, period.to);
  const aggregates = await activityAggregates(db, ids, period.from, period.to);
  const members = await personMembersOf(db, ids);
  const children = below.filter(d => d.parentContextId === context.id);
  const summary = childSummary({
    targetType: context.targetType, children, branchOf: branchMap(context.id, below), aggregates, members, months,
  });
  return { contextId: context.id, period, months, ...summary };
}
