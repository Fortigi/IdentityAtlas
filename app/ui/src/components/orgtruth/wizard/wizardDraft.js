// Organisation → Import wizard: the draft and every edit to it (PURE).
//
// The wizard's whole state is one plain object (the "draft"); every control in
// the seven step panels calls one of the functions below and hands the result to
// setDraft. Nothing here touches React, the network or the clock, so the edits
// are unit-tested and mutation-tested on their own (stryker.orgtruth.config.json).
//
// Draft shape:
//   { mode: 'new' | 'repeat', profile: null | { id, name, version, recipe, linkRules },
//     runMode: 'full' | 'delta', adjust: false,
//     source: null | { id, displayName, fileName, observedAt, rowCount, columns: [profile columns] },
//     recipe: { version: 1, entities: [], relations: [] }, linkRules: [],
//     proposalOrigin: null | 'model' | 'heuristic', notes: [],
//     templateProposal: null | { kind, confidence, reason, alternatives }, templateChosen: false,
//     detection: { [entityType]: [candidates] }, quality: null | report, qualityStale: false,
//     threshold: 50, profileName: '' }
//
// The recipe and link-rule shapes are the shared contracts in
// app/api/src/orgtruth/contracts.js. The UI cannot import across packages, so
// LINK_TARGETS, SIGNAL_TYPES and the two limits below are copied from there;
// keep them in sync (the API validates again on every write, so a drift shows
// up as a 400 with a sentence, never as bad data).
//
// Decisions made here (not spelled out in the handover):
//   - An entity in the draft may carry keyColumn: '' while being edited; the
//     contracts reject an empty keyColumn, so recipeForApi() drops it.
//   - Renaming an entity type renames it in the relations, its link rules and
//     its detection results, so an edit never leaves dangling references.
//   - Removing the last signal of a rule removes that rule (the contracts
//     require at least one signal per rule); other rules of the entity stay.
//   - A rule's target type is fixed by the candidate that created it; a
//     candidate for another target type or attribute starts another rule.
//   - Repeat mode saves a new profile version when the analyst adjusted the
//     configuration OR the recipe / link rules differ from the stored profile.
//   - recipe.template picks the recipe's shape (templateDraft.js); a recipe
//     without one is a collection and is sent without it, exactly as before.
//     templateProposal is the UNFORCED proposal's template block: picking
//     another kind re-proposes (templateChosen) but keeps it, so the card the
//     data suggested stays marked with its reason.
//   - Activity and relation imports send no link rules (the API generates
//     what they need); a collection or enrichment sends the draft's rules.

import {
  activityFindings, activityForApi, activityProblems, attributesForApi, enrichmentProblems, linksTemplate, proposalTemplate,
  proposedKind, relationForApi, relationProblems, sectionColumns, templateOf, withTemplateDefaults,
} from './templateDraft';

export const LINK_TARGETS = Object.freeze({
  Principal: ['email', 'employeeId', 'displayName'],
  Identity:  ['email', 'employeeId', 'displayName'],
  Resource:  ['displayName', 'mail', 'externalId'],
  Context:   ['displayName'],
  OrgEntity: ['displayName'],
});
export const SIGNAL_TYPES = ['exact', 'prefix', 'name', 'token', 'fuzzy'];
export const MAX_SIGNALS_PER_RULE = 10;
export const NAME_ATTRIBUTE = 'displayName';
export const DEFAULT_THRESHOLD = 50;

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
const replaceAt = (list, i, item) => list.map((x, idx) => (idx === i ? item : x));
const withoutAt = (list, i) => list.filter((_, idx) => idx !== i);
const emptyRecipe = () => ({ version: 1, entities: [], relations: [] });
const kindOf = (draft) => templateOf(draft.recipe);

// ─── Creating and choosing ───────────────────────────────────────────────
export function emptyDraft(profile = null) {
  const base = {
    mode: 'new', profile: null, runMode: 'full', adjust: false, source: null,
    recipe: emptyRecipe(), linkRules: [], proposalOrigin: null, notes: [], templateProposal: null, templateChosen: false,
    detection: {}, quality: null, qualityStale: false, threshold: DEFAULT_THRESHOLD, profileName: '',
  };
  return profile ? selectProfile(base, profile) : base;
}

export function setMode(draft, mode) {
  if (mode === 'new') return { ...emptyDraft(), source: draft.source, runMode: draft.runMode };
  return { ...draft, mode: 'repeat' };
}

// A stored profile's recipe in the shape its template needs; a collection
// recipe is used as stored. The template may sit on the recipe or the profile.
export function profileRecipe(profile) {
  const recipe = profile?.recipe ?? emptyRecipe();
  const kind = recipe.template ?? profile?.template;
  return !kind || kind === 'collection' ? recipe : withTemplateDefaults(recipe, kind);
}

export function selectProfile(draft, profile) {
  const recipe = profileRecipe(profile);
  const linkRules = profile.linkRules ?? [];
  return {
    ...draft, mode: 'repeat', profile, recipe, linkRules,
    threshold: linkRules[0]?.threshold ?? DEFAULT_THRESHOLD,
    profileName: profile.name ?? '', detection: {}, quality: null, templateProposal: null, templateChosen: false,
  };
}

// The profile picker shows one entry per name: the highest version.
export function latestProfiles(list) {
  const byName = new Map();
  for (const p of list ?? []) {
    const cur = byName.get(p.name);
    if (!cur || (p.version ?? 0) > (cur.version ?? 0)) byName.set(p.name, p);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A new source invalidates what was measured against the old one.
export function setSource(draft, source) {
  return { ...draft, source, detection: {}, quality: null };
}

export function columnNames(draft) {
  return (draft.source?.columns ?? []).map(c => c.name);
}

// forcedKind: the proposal answers POST /propose/recipe { template } — the
// analyst's choice — so the recipe takes that shape whatever the answer says,
// and the unforced proposal's template block stays.
export function applyProposal(draft, proposal, forcedKind = null) {
  const linkRules = (proposal.linkRules ?? []).map(r => ({ ...r, via: ruleVia(r), threshold: r.threshold ?? draft.threshold }));
  return {
    ...draft,
    recipe: withTemplateDefaults({ ...emptyRecipe(), ...proposal.recipe }, forcedKind ?? proposedKind(proposal)),
    linkRules,
    proposalOrigin: proposal.origin ?? 'heuristic',
    notes: proposal.notes ?? [],
    templateProposal: forcedKind ? draft.templateProposal : proposalTemplate(proposal),
    templateChosen: !!forcedKind,
    detection: {}, quality: null,
  };
}

// The analyst picks a kind: an empty recipe of that shape (filled by the
// re-proposal when it answers) and no rules carried over from another kind.
export function chooseTemplate(draft, kind) {
  return {
    ...draft, recipe: withTemplateDefaults(emptyRecipe(), kind), linkRules: [], notes: [],
    templateChosen: true, detection: {}, quality: null,
  };
}

// An edit to a template section: fn(recipe) → recipe (templateDraft.js edits).
export const editTemplate = (draft, fn) => ({ ...draft, recipe: fn(draft.recipe), quality: null });

// ─── Entities, attributes, relations ─────────────────────────────────────
const withRecipe = (draft, recipe) => ({ ...draft, recipe, quality: null });

export function addEntity(draft) {
  const entity = { type: '', nameColumn: '', keyColumn: '', nameAttribute: '', attributes: [] };
  return withRecipe(draft, { ...draft.recipe, entities: [...draft.recipe.entities, entity] });
}

function renameType(draft, from, to) {
  const swap = (t) => (t === from ? to : t);
  const relations = draft.recipe.relations.map(r => ({ ...r, from: swap(r.from), to: swap(r.to) }));
  const linkRules = draft.linkRules.map(r => (r.entityType === from ? { ...r, entityType: to } : r));
  const detection = { ...draft.detection };
  if (from in detection) { detection[to] = detection[from]; delete detection[from]; }
  return { ...draft, recipe: { ...draft.recipe, relations }, linkRules, detection };
}

export function updateEntity(draft, i, patch) {
  const old = draft.recipe.entities[i];
  if (!old) return draft;
  const renamed = 'type' in patch && old.type && patch.type !== old.type ? renameType(draft, old.type, patch.type) : draft;
  const entities = replaceAt(renamed.recipe.entities, i, { ...old, ...patch });
  return withRecipe(renamed, { ...renamed.recipe, entities });
}

export function removeEntity(draft, i) {
  const old = draft.recipe.entities[i];
  if (!old) return draft;
  const type = old.type;
  const relations = draft.recipe.relations.filter(r => r.from !== type && r.to !== type);
  const detection = { ...draft.detection };
  delete detection[type];
  return {
    ...withRecipe(draft, { ...draft.recipe, entities: withoutAt(draft.recipe.entities, i), relations }),
    linkRules: draft.linkRules.filter(r => r.entityType !== type),
    detection,
  };
}

function editAttributes(draft, i, fn) {
  const entity = draft.recipe.entities[i];
  if (!entity) return draft;
  return updateEntity(draft, i, { attributes: fn(entity.attributes ?? []) });
}

export const addAttribute = (draft, i) => editAttributes(draft, i, a => [...a, { column: '', name: '' }]);
export const updateAttribute = (draft, i, j, patch) => editAttributes(draft, i, a => (a[j] ? replaceAt(a, j, { ...a[j], ...patch }) : a));
export const removeAttribute = (draft, i, j) => editAttributes(draft, i, a => withoutAt(a, j));

export function addRelation(draft) {
  const types = draft.recipe.entities.map(e => e.type).filter(Boolean);
  const relation = { predicate: '', from: types[0] ?? '', to: types[1] ?? types[0] ?? '' };
  return withRecipe(draft, { ...draft.recipe, relations: [...draft.recipe.relations, relation] });
}

export function updateRelation(draft, k, patch) {
  const old = draft.recipe.relations[k];
  if (!old) return draft;
  return withRecipe(draft, { ...draft.recipe, relations: replaceAt(draft.recipe.relations, k, { ...old, ...patch }) });
}

export const removeRelation = (draft, k) => withRecipe(draft, { ...draft.recipe, relations: withoutAt(draft.recipe.relations, k) });

// The attribute names an entity exposes to link rules: its name plus every
// mapped column (an attribute's name defaults to its column header).
export function entityAttributeNames(entity) {
  const names = [NAME_ATTRIBUTE];
  for (const a of entity?.attributes ?? []) {
    const n = trimmed(a.name) || trimmed(a.column);
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

// ─── Link rules ──────────────────────────────────────────────────────────
// A rule links ONE attribute of an entity (its `via`: 'displayName' for the
// entity's own name, or an attribute such as 'owner' or 'team') to ONE target
// type. A rule is identified by (entityType, targetType, via); an entity may
// have several. A rule without `via` (an older profile) links through its
// first signal's attribute, as the API defaults it.
export const ruleVia = (rule) => rule.via ?? rule.signals?.[0]?.attribute ?? NAME_ATTRIBUTE;
export const ruleKey = (rule) => `${rule.entityType}|${rule.targetType}|${ruleVia(rule)}`;

// "owner → Principal", "Team name → Resource".
export function ruleTitle(rule) {
  const via = ruleVia(rule);
  return `${via === NAME_ATTRIBUTE ? `${rule.entityType} name` : via} → ${rule.targetType}`;
}

// A rule is referenced by its index in draft.linkRules or by its ruleKey.
const findRule = (draft, ref) => (typeof ref === 'number' ? ref : draft.linkRules.findIndex(r => ruleKey(r) === ref));

function putRule(draft, idx, rule) {
  let linkRules;
  if (rule === null) linkRules = withoutAt(draft.linkRules, idx);
  else linkRules = idx < 0 ? [...draft.linkRules, rule] : replaceAt(draft.linkRules, idx, rule);
  return { ...draft, linkRules, quality: null };
}

const sameSignal = (s, c) => s.attribute === c.attribute && s.targetField === c.targetField && s.type === c.type;

// Accept a detected candidate: add it as a signal to the rule that links the
// same attribute to the same target type (creating that rule when there is
// none), or update its weight if the same signal is already there.
export function acceptCandidate(draft, entityType, c) {
  const idx = draft.linkRules.findIndex(r => r.entityType === entityType && r.targetType === c.targetType && ruleVia(r) === c.attribute);
  const base = idx < 0
    ? { entityType, targetType: c.targetType, via: c.attribute, threshold: draft.threshold, signals: [] }
    : draft.linkRules[idx];
  const signal = { attribute: c.attribute, targetField: c.targetField, type: c.type, weight: clampInt(c.suggestedWeight ?? 50, 1, 100) };
  const at = base.signals.findIndex(s => sameSignal(s, c));
  if (at < 0 && base.signals.length >= MAX_SIGNALS_PER_RULE) return draft;
  const signals = at < 0 ? [...base.signals, signal] : replaceAt(base.signals, at, { ...base.signals[at], weight: signal.weight });
  return putRule(draft, idx, { ...base, signals });
}

export function removeRule(draft, ref) {
  const idx = findRule(draft, ref);
  return draft.linkRules[idx] ? putRule(draft, idx, null) : draft;
}

export function updateSignal(draft, ref, j, patch) {
  const idx = findRule(draft, ref);
  const rule = draft.linkRules[idx];
  if (!rule?.signals[j]) return draft;
  const next = { ...rule.signals[j], ...patch };
  if ('weight' in patch) next.weight = clampInt(patch.weight, 1, 100);
  return putRule(draft, idx, { ...rule, signals: replaceAt(rule.signals, j, next) });
}

// Removing the last signal removes that rule (and only that rule).
export function removeSignal(draft, ref, j) {
  const idx = findRule(draft, ref);
  const rule = draft.linkRules[idx];
  if (!rule?.signals[j]) return draft;
  const signals = withoutAt(rule.signals, j);
  return putRule(draft, idx, signals.length ? { ...rule, signals } : null);
}

// "Owner matches 94 % unique on Principal.email" — the line a candidate reads as.
export function candidateSentence(entityType, c) {
  const what = c.attribute === NAME_ATTRIBUTE ? `${entityType} name` : c.attribute;
  return `${what} matches ${Math.round(c.uniquePct ?? 0)} % unique on ${c.targetType}.${c.targetField}`;
}

export function setDetection(draft, entityType, candidates) {
  return { ...draft, detection: { ...draft.detection, [entityType]: candidates } };
}

// The slider writes the threshold into every rule. A report measured with the
// old threshold stays visible but is marked stale until the check is re-run.
export function setThreshold(draft, value) {
  const threshold = clampInt(value, 0, 100);
  return { ...draft, threshold, qualityStale: draft.quality !== null, linkRules: draft.linkRules.map(r => ({ ...r, threshold })) };
}

// Percent shares (whole numbers) of a link-stats block, for the quality bar.
export function linkShares(stats) {
  const counts = { unique: stats?.unique ?? 0, ambiguous: stats?.ambiguous ?? 0, none: stats?.none ?? 0 };
  const sum = counts.unique + counts.ambiguous + counts.none;
  const pct = (n) => (sum === 0 ? 0 : Math.round((n / sum) * 100));
  return { unique: pct(counts.unique), ambiguous: pct(counts.ambiguous), none: pct(counts.none) };
}

export function setQuality(draft, report) {
  return { ...draft, quality: report, qualityStale: false };
}

// ─── Readiness and verdict ───────────────────────────────────────────────
// Sentences describing what keeps the recipe from being valid (a subset of
// validateRecipe in the contracts: the parts an editor can get wrong).
export function recipeProblems(draft) {
  const kind = kindOf(draft);
  if (kind === 'activity') return activityProblems(draft.recipe.activity);
  if (kind === 'relation') return relationProblems(draft.recipe.relation);
  if (kind === 'enrichment') return enrichmentProblems(draft.recipe);
  return collectionProblems(draft);
}

function collectionProblems(draft) {
  const problems = [];
  const entities = draft.recipe.entities;
  if (entities.length === 0) problems.push('Add at least one entity.');
  const seen = new Set();
  entities.forEach((e, i) => {
    const type = trimmed(e.type);
    if (!type) problems.push(`Entity ${i + 1} has no type.`);
    else if (seen.has(type)) problems.push(`Entity type "${type}" is defined more than once.`);
    else seen.add(type);
    if (!trimmed(e.nameColumn)) problems.push(`Entity ${i + 1} has no name column.`);
  });
  draft.recipe.relations.forEach((r, k) => {
    if (!trimmed(r.predicate)) problems.push(`Relation ${k + 1} has no predicate.`);
    if (!seen.has(trimmed(r.from)) || !seen.has(trimmed(r.to))) problems.push(`Relation ${k + 1} refers to an entity type the recipe does not define.`);
  });
  return problems;
}

// Columns the recipe refers to that the (new) source no longer has.
export function staleColumns(draft) {
  if (!draft.source) return [];
  const have = new Set(columnNames(draft));
  const cols = (draft.recipe.entities ?? []).flatMap(e => [e.nameColumn, e.keyColumn, ...(e.attributes ?? []).map(a => a.column)]);
  const used = [];
  for (const col of [...cols, ...sectionColumns(draft.recipe)]) {
    if (trimmed(col) && !have.has(col) && !used.includes(col)) used.push(col);
  }
  return used;
}

const plural = (n, one, many) => (n === 1 ? one : many);

// The dry-run report keys `links` by rule name; each block says which entity
// type, target type and attribute (`via`) it measured. "Project name → Resource",
// "Project.team → Principal". A block without entityType falls back to its key.
export function linkBlockLabel(name, block) {
  if (!block?.entityType) return name;
  const label = !block.via || block.via === NAME_ATTRIBUTE ? `${block.entityType} name` : `${block.entityType}.${block.via}`;
  return `${label} → ${block.targetType}`;
}

function linkFindings(links, blockers, warnings) {
  for (const [name, s] of Object.entries(links ?? {})) {
    const label = linkBlockLabel(name, s);
    if (s.unique === 0) blockers.push(`No ${label} value matched uniquely: the link rule finds nothing it can link. Adjust the rule or remove it.`);
    else if (s.none > s.unique) warnings.push(`More ${label} values have no match (${s.none}) than a unique one (${s.unique}).`);
  }
}

function keyWarnings(entities, warnings) {
  for (const [type, e] of Object.entries(entities ?? {})) {
    if (e.duplicateKeys > 0) warnings.push(`${type} has ${e.duplicateKeys} duplicate ${plural(e.duplicateKeys, 'key', 'keys')}; the first row wins.`);
    if (e.emptyKeys > 0) warnings.push(`${type} has ${e.emptyKeys} ${plural(e.emptyKeys, 'row', 'rows')} without a key; those are skipped.`);
  }
}

function closeWarnings(wouldClose, warnings) {
  for (const [type, n] of Object.entries(wouldClose ?? {})) {
    if (n > 0) warnings.push(`A full import closes ${n} ${type} ${plural(n, 'entry', 'entries')} the new list no longer contains.`);
  }
}

// Blocks when an entity type with a link rule has no unique match at all;
// warns when more entries have no match than a unique one, on duplicate or
// empty keys, on what a full run closes, and on a weak threshold.
export function qualityVerdict(report, threshold) {
  if (!report) return { canStart: false, warnings: [], blockers: ['Run the data-quality check first.'] };
  const blockers = [];
  const warnings = [];
  linkFindings(report.links, blockers, warnings);
  keyWarnings(report.entities, warnings);
  closeWarnings(report.wouldClose, warnings);
  activityFindings(report, blockers, warnings);
  if (threshold < 30) warnings.push(`A threshold of ${threshold} links on weak evidence; most links will need review.`);
  return { canStart: blockers.length === 0, warnings, blockers };
}

// The rule an enrichment needs: one that links its list to the target type
// (any attribute; the key column's rule is the usual one). Null when missing.
export function enrichKeyRule(draft) {
  const type = trimmed(draft.recipe.entities[0]?.type);
  const target = draft.recipe.enrich?.targetType;
  return draft.linkRules.find(r => r.entityType === type && r.targetType === target) ?? null;
}

// The steps: 1 Start, 2 Source, 3 Kind, 4 Model, 5 Links, 6 Quality, 7 Confirm.
export const LAST_STEP = 7;

export function stepReady(step, draft) {
  switch (step) {
    case 1: return draft.mode === 'new' || draft.profile !== null;
    case 2: return draft.source !== null;
    case 3: return true;
    case 4: return recipeProblems(draft).length === 0;
    case 5: return kindOf(draft) !== 'enrichment' || enrichKeyRule(draft) !== null;
    case 6: return !draft.qualityStale && qualityVerdict(draft.quality, draft.threshold).canStart;
    case 7: return trimmed(draft.profileName).length > 0;
    default: return false;
  }
}

// Steps 3 and 4 are shown for a new import, or for a repeat the analyst adjusts.
export const modelStepShown = (draft) => draft.mode === 'new' || draft.adjust;

// Step 5 (links) only for the kinds that carry link rules.
export function stepShown(step, draft) {
  if (step === 3 || step === 4) return modelStepShown(draft);
  if (step === 5) return linksTemplate(kindOf(draft));
  return true;
}

// Step 3 proposes on its own when it opens on a source with nothing proposed
// or modelled yet. A recipe that is already there (a repeat's profile, a kind
// the analyst picked, or one started after a failed proposal) is never
// overwritten unasked.
export const shouldAutoPropose = (draft) => modelStepShown(draft) && draft.source !== null
  && draft.proposalOrigin === null && !draft.templateChosen
  && kindOf(draft) === 'collection' && draft.recipe.entities.length === 0;

export function nextStep(step, draft) {
  let n = step + 1;
  while (n < LAST_STEP && !stepShown(n, draft)) n += 1;
  return n;
}

export function prevStep(step, draft) {
  let n = step - 1;
  while (n > 1 && !stepShown(n, draft)) n -= 1;
  return n;
}

// ─── What the API receives ───────────────────────────────────────────────
function entitiesForApi(entities) {
  return entities.map(e => {
    const out = { type: trimmed(e.type), nameColumn: e.nameColumn };
    if (trimmed(e.keyColumn)) out.keyColumn = e.keyColumn;
    if (trimmed(e.nameAttribute)) out.nameAttribute = trimmed(e.nameAttribute);
    out.attributes = attributesForApi(e.attributes);
    return out;
  });
}

// A collection goes out as before, without `template`; the other kinds carry it.
export function recipeForApi(recipe) {
  const kind = templateOf(recipe);
  if (kind === 'activity') return { version: 1, template: kind, activity: activityForApi(recipe.activity) };
  if (kind === 'relation') return { version: 1, template: kind, relation: relationForApi(recipe.relation) };
  const out = {
    version: 1,
    entities: entitiesForApi(recipe.entities),
    relations: recipe.relations.map(r => ({ predicate: trimmed(r.predicate), from: trimmed(r.from), to: trimmed(r.to) })),
  };
  return kind === 'enrichment' ? { ...out, template: kind, enrich: { targetType: recipe.enrich?.targetType } } : out;
}

const rulesForApi = (draft) => (linksTemplate(kindOf(draft)) ? draft.linkRules : []);

export function profileBody(draft) {
  return { name: trimmed(draft.profileName), sourceKind: 'list', recipe: recipeForApi(draft.recipe), linkRules: rulesForApi(draft) };
}

// POST /propose/recipe takes the column profile, not the source id (integrator
// contract update): { fileName, columns, rowCount? }. `template` forces the
// kind of list (the analyst's pick on step 3); without it the server proposes one.
export function proposeBody(draft, template) {
  const s = draft.source ?? {};
  const body = { fileName: s.fileName || s.displayName || '', columns: s.columns ?? [] };
  if (Number.isInteger(s.rowCount)) body.rowCount = s.rowCount;
  // the stored source lets the server probe the VALUES against accounts and other lists
  if (s.id) body.sourceId = s.id;
  if (template) body.template = template;
  return body;
}

// GET /propose/status → { configured, available, model, loaded, promptCache, reason }.
// True when the proposal can only come from the column names (no model).
export function columnNamesOnly(status) {
  return !!status && (status.configured === false || status.available === false);
}

export function dryRunBody(draft) {
  return { sourceId: draft.source?.id, recipe: recipeForApi(draft.recipe), linkRules: rulesForApi(draft), mode: draft.runMode };
}

// 'create' a new profile, save a new 'version' of the chosen one, or 'reuse' it as is.
export function profileAction(draft) {
  if (draft.mode === 'new' || !draft.profile) return 'create';
  if (draft.adjust) return 'version';
  const same = JSON.stringify(recipeForApi(draft.recipe)) === JSON.stringify(recipeForApi(profileRecipe(draft.profile)))
    && JSON.stringify(draft.linkRules) === JSON.stringify(draft.profile.linkRules ?? []);
  return same ? 'reuse' : 'version';
}

// The sentence step 6 shows about the profile (null: a new profile, named in a field).
export function profileLine(draft) {
  const action = profileAction(draft);
  if (action === 'create') return null;
  const { name, version } = draft.profile;
  return action === 'version' ? `Saves version ${(version ?? 0) + 1} of ${name}.` : `Uses ${name} version ${version}.`;
}
