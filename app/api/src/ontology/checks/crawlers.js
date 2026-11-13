// Agreement between the ontology's types and what the crawlers declare they
// write.
//
// Each crawler manifest (tools/crawlers/<dir>/crawler.json) carries an `emits`
// block: the principal, resource and context types it writes as fixed values or
// as the defaults of its built-in mappings, and the type fields it passes free
// values through for (from source data or its configuration). The check:
//   - every declared type is a subclass of the right core class, and its
//     ia:emittedBy names that crawler;
//   - every ia:emittedBy names a crawler that still declares the type (so a
//     crawler that stops writing a type fails until the ontology follows);
//   - ia:passthroughFrom on ia:Principal / ia:Resource / ia:Context is exactly
//     the set of crawlers whose `emits.open` lists that field.
// That the declarations match what the crawler code really sends is checked by
// src/ontology/crawlerEmits.guard.test.js, as far as literals can be scanned.

import { typedSubclasses } from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });

/** emits key → [core class, the column that holds the type]. */
export const EMITTED_KINDS = {
  principalTypes: ['Principal', 'principalType'],
  resourceTypes: ['Resource', 'resourceType'],
  contextTypes: ['Context', 'contextType'],
};
const KIND_KEYS = Object.keys(EMITTED_KINDS);
const OPEN_FIELDS = new Set(Object.values(EMITTED_KINDS).map(([, column]) => column));

function declaredShape(crawler) {
  const e = crawler.emits;
  if (!e || typeof e !== 'object') return 'declares no emits block';
  const bad = [...KIND_KEYS, 'open'].filter(k => !Array.isArray(e[k]));
  if (bad.length) return `emits.${bad.join(', emits.')} must be a list`;
  const unknownOpen = e.open.filter(f => !OPEN_FIELDS.has(f));
  return unknownOpen.length ? `emits.open names ${unknownOpen.join(', ')}, which is not a type column` : null;
}

function checkDeclared(byKind, crawler) {
  const out = [];
  for (const key of KIND_KEYS) {
    const [root] = EMITTED_KINDS[key];
    for (const value of crawler.emits[key]) {
      const cls = byKind[key].get(value);
      if (!cls) out.push(err('crawler-type-undefined', `${root}:${value}`, `crawler ${crawler.type} writes ${root.toLowerCase()} type "${value}", which is not a subclass of ia:${root} in the ontology`));
      else if (!cls.emittedBy.includes(crawler.type)) out.push(err('crawler-emitter-undeclared', `ia:${cls.local}`, `crawler ${crawler.type} writes "${value}" but ia:emittedBy does not name it`));
    }
  }
  return out;
}

function checkEmitters(byKind, crawlers) {
  const byType = new Map(crawlers.map(c => [c.type, c]));
  const out = [];
  for (const key of KIND_KEYS) {
    for (const cls of byKind[key].values()) {
      for (const type of cls.emittedBy) {
        const crawler = byType.get(type);
        if (!crawler) out.push(err('crawler-emitter-unknown', `ia:${cls.local}`, `ia:emittedBy "${type}" is not a crawler type`));
        else if (Array.isArray(crawler.emits?.[key]) && !crawler.emits[key].includes(cls.typeValue)) {
          out.push(err('crawler-emitter-stale', `ia:${cls.local}`, `ia:emittedBy "${type}", but that crawler no longer declares "${cls.typeValue}"`));
        }
      }
    }
  }
  return out;
}

function checkPassthrough(model, crawlers) {
  const out = [];
  for (const [root, column] of Object.values(EMITTED_KINDS)) {
    const cls = model.classes.get(root);
    if (!cls) continue;
    const expected = crawlers.filter(c => c.emits?.open?.includes(column)).map(c => c.type).sort();
    const missing = expected.filter(t => !cls.passthroughFrom.includes(t));
    const extra = cls.passthroughFrom.filter(t => !expected.includes(t));
    if (missing.length || extra.length) {
      out.push(err('crawler-passthrough-mismatch', `ia:${root}`, `ia:passthroughFrom lists ${cls.passthroughFrom.join(', ') || 'nothing'}; the manifests that pass ${column} through are ${expected.join(', ') || 'none'}`));
    }
  }
  return out;
}

/** Crawler-type agreement. `registry.crawlers` = [{ type, emits }]. */
export function checkCrawlerTypes(model, registry) {
  if (!registry.crawlers) return [];
  const byKind = Object.fromEntries(KIND_KEYS.map(key => [key,
    new Map(typedSubclasses(model, EMITTED_KINDS[key][0]).map(c => [c.typeValue, c]))]));
  const out = [];
  const valid = [];
  for (const crawler of registry.crawlers) {
    const problem = declaredShape(crawler);
    if (problem) out.push(err('crawler-emits-invalid', `crawler:${crawler.type}`, `${problem} (crawler.json)`));
    else valid.push(crawler);
  }
  out.push(...valid.flatMap(c => checkDeclared(byKind, c)), ...checkEmitters(byKind, registry.crawlers), ...checkPassthrough(model, registry.crawlers));
  return out;
}
