// Which contexts a matrix leans on — and whether they still exist.
//
// Contexts get created and removed all the time, and a matrix that names one
// keeps naming it after it is gone. buildEntitySubquery drops such a condition
// with a warning (filterSql.js) rather than failing, which is right for one
// request and wrong as a silence: the matrix no longer filters the way it was
// saved. Widened past what it can load, it reads as "this matrix produces
// nothing any more" — and nothing on screen said why.
//
// Answering it is cheap: no matrix is run, the ids are read out of the stored
// filter and looked up once for a whole list.

import { collectContextIds } from './filterSql.js';

// Every context a filter DEPENDS ON: the ids in its conditions (collectContextIds
// owns that half, and is what the condition builder itself resolves), plus the
// tree it is rolled up by and the one it is sorted by. Those last two are just
// as breakable — a roll-up by a deleted tree has nothing to group by — so one
// definition covers all three and no caller has to remember the other two.
export function referencedContextIds(filter) {
  const ids = new Set(collectContextIds(filter));
  if (filter?.rollupKind === 'context') addId(ids, filter.rollupContextId);
  addId(ids, filter?.sortHierarchy?.contextId);
  return [...ids];
}

function addId(ids, value) {
  if (typeof value === 'string' && value) ids.add(value);
}

// The referenced ids that are gone, given what a lookup found. `existing` is a
// Set or a Map keyed by id — resolveContextTypes hands back the latter.
export function missingContextIds(referenced, existing) {
  return referenced.filter(id => !existing.has(id));
}

// The whole check for a list of saved matrices: the ids to look up, and a
// function that labels each row once the answer is back. Kept together so a
// caller can't look one set of ids up and then judge the rows by another.
export function contextHealthPlan(rows) {
  const byRow = new Map();
  const all = new Set();
  for (const row of rows || []) {
    const ids = referencedContextIds(row?.filter);
    byRow.set(row, ids);
    for (const id of ids) all.add(id);
  }
  return {
    lookup: [...all],
    label(existing) {
      return (rows || []).map(row => ({
        ...row,
        missingContextIds: missingContextIds(byRow.get(row) || [], existing),
      }));
    },
  };
}
