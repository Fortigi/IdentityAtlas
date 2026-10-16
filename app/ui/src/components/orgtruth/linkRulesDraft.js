// Organisation → Model → Link rules: the pure state behind the rule canvas.
//
// A link rule (app/api/src/orgtruth/contracts.js) links ONE attribute of an
// entity type (its `via`; 'displayName' is the entity's own name) to ONE target:
//   { entityType, targetType, via, targetEntityType?, threshold, name?,
//     signals: [{ attribute, targetField, type, weight }] }
// targetType is a system type (Principal, Identity, Resource, Context) or
// OrgEntity (an entity of ANOTHER list, named by targetEntityType). The API
// identifies a rule by (entityType, targetType, via) and refuses two rules with
// the same key; so does addRule/replaceRule here, before the round trip.
//
// The canvas works by rows: an attribute row of an entity box is a SOURCE, a
// field row of a system box (or the name row of another entity box) is a
// TARGET. rowAction decides what a click on a row does.
import { NAME_ATTRIBUTE, MAX_SIGNALS_PER_RULE, ruleVia, ruleKey } from './wizard/wizardDraft';
import { API } from './wizard/wizardApi';

// The system fields a rule may match on, per target (LINK_TARGETS in the API).
export const SYSTEM_TARGETS = [
  { targetType: 'Principal', title: 'Account', fields: ['displayName', 'email', 'employeeId'] },
  { targetType: 'Identity', title: 'Person', fields: ['displayName', 'email', 'employeeId'] },
  { targetType: 'Resource', title: 'Group/resource', fields: ['displayName', 'mail', 'externalId'] },
  { targetType: 'Context', title: 'Context', fields: ['displayName'] },
];
export const SIGNAL_TYPES = ['exact', 'prefix', 'name', 'token', 'fuzzy'];

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
const signal = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });

export const viaLabel = (via) => (via === NAME_ATTRIBUTE ? 'name' : via);

// "Account", "Person", … for a system target; the list's entity type for OrgEntity.
export function targetTitle(targetType, targetEntityType) {
  if (targetType === 'OrgEntity') return targetEntityType || 'Another list';
  return SYSTEM_TARGETS.find(s => s.targetType === targetType)?.title ?? targetType;
}

// A target field as the canvas names it: another list's name row is 'name',
// a system field keeps its column name ('displayName', 'email').
export const targetFieldLabel = (targetType, field) => (targetType === 'OrgEntity' ? 'name' : field);

// The target field a rule's line ends on: the first signal's field, or the
// other list's name row.
export function lineField(rule) {
  if (rule.targetType === 'OrgEntity') return NAME_ATTRIBUTE;
  return rule.signals?.[0]?.targetField ?? NAME_ATTRIBUTE;
}

// The signals a new rule starts with. Person targets: exact 80 + name 60 on
// the name, exact 90 on an email (the clicked field, or an attribute whose name
// says mail) or an employee id; groups: exact 80 + token 50; contexts: exact
// 80; another list: fuzzy 100 on its name.
export function defaultSignals(targetType, attribute, field = NAME_ATTRIBUTE) {
  if (targetType === 'OrgEntity') return [signal(attribute, NAME_ATTRIBUTE, 'fuzzy', 100)];
  if (targetType === 'Context') return [signal(attribute, field, 'exact', 80)];
  if (targetType === 'Resource') return [signal(attribute, field, 'exact', 80), signal(attribute, field, 'token', 50)];
  if (field === 'email' || (field === NAME_ATTRIBUTE && /mail/i.test(attribute))) return [signal(attribute, 'email', 'exact', 90)];
  if (field === 'employeeId') return [signal(attribute, field, 'exact', 90)];
  return [signal(attribute, field, 'exact', 80), signal(attribute, field, 'name', 60)];
}

export const defaultThreshold = (targetType) => (targetType === 'OrgEntity' ? 60 : 50);

// source { entityType, attribute }, target { targetType, targetEntityType?, field }
export function newRule(source, target) {
  return {
    entityType: source.entityType,
    targetType: target.targetType,
    via: source.attribute,
    ...(target.targetType === 'OrgEntity' ? { targetEntityType: target.targetEntityType } : {}),
    threshold: defaultThreshold(target.targetType),
    signals: defaultSignals(target.targetType, source.attribute, target.field),
  };
}

export const signalsSummary = (signals) => (signals ?? []).map(s => `${s.type} ${s.weight}`).join(' + ');

// "Timesheet · column4 → Customer", "Customer · name → Resource".
export function ruleLabel(rule) {
  return `${rule.entityType} · ${viaLabel(ruleVia(rule))} → ${rule.targetEntityType ?? rule.targetType}`;
}

// ─── The rule list ─────────────────────────────────────────────────────

function duplicateError(rules, rule, except) {
  const key = ruleKey(rule);
  if (!rules.some((r, i) => i !== except && ruleKey(r) === key)) return null;
  return `${rule.entityType} already links ${viaLabel(ruleVia(rule))} to ${rule.targetType}; edit that rule instead.`;
}

export function addRule(rules, rule) {
  const error = duplicateError(rules, rule, -1);
  return error ? { rules, error } : { rules: [...rules, rule], error: null };
}

export function replaceRule(rules, index, rule) {
  const error = duplicateError(rules, rule, index);
  return error ? { rules, error } : { rules: rules.map((r, i) => (i === index ? rule : r)), error: null };
}

export const removeRuleAt = (rules, index) => rules.filter((_, i) => i !== index);

// ─── One rule in the popover ────────────────────────────────────────────

export function updateRuleSignal(rule, j, patch) {
  if (!rule.signals[j]) return rule;
  const next = { ...rule.signals[j], ...patch };
  if ('weight' in patch) next.weight = clampInt(patch.weight, 1, 100);
  return { ...rule, signals: rule.signals.map((s, i) => (i === j ? next : s)) };
}

export function addRuleSignal(rule) {
  if (rule.signals.length >= MAX_SIGNALS_PER_RULE) return rule;
  return { ...rule, signals: [...rule.signals, signal(ruleVia(rule), lineField(rule), 'exact', 50)] };
}

// A rule keeps at least one signal; remove the rule itself to drop the last.
export function removeRuleSignal(rule, j) {
  if (rule.signals.length <= 1) return rule;
  return { ...rule, signals: rule.signals.filter((_, i) => i !== j) };
}

export const setRuleThreshold = (rule, value) => ({ ...rule, threshold: clampInt(value, 0, 100) });

// ─── Canvas interaction ──────────────────────────────────────────────────

// row: { entityType?, attribute?, source: bool, target: { targetType, targetEntityType?, field } | null }
// selection: { entityType, attribute } | null. A row is a target for the
// selection unless it is the name row of the selection's own entity type.
function targetsSelection(selection, row) {
  if (!selection || !row.target) return false;
  return !(row.target.targetType === 'OrgEntity' && row.target.targetEntityType === selection.entityType);
}

export function rowAction(selection, row, canEdit) {
  if (!canEdit) return { type: 'none' };
  if (targetsSelection(selection, row)) return { type: 'open', source: selection, target: row.target };
  if (!row.source) return { type: 'none' };
  if (selection?.entityType === row.entityType && selection.attribute === row.attribute) return { type: 'clear' };
  return { type: 'select', source: { entityType: row.entityType, attribute: row.attribute } };
}

// The accessible name of a row: what a click on it does once a source is
// selected ("Link Timesheet column4 to Account displayName"), else what it is
// ("owner on Customer").
export function rowName(selection, row, boxTitle) {
  if (targetsSelection(selection, row)) {
    const t = row.target;
    return `Link ${selection.entityType} ${viaLabel(selection.attribute)} to ${targetTitle(t.targetType, t.targetEntityType)} ${targetFieldLabel(t.targetType, t.field)}`;
  }
  return `${viaLabel(row.attribute ?? row.target?.field)} on ${boxTitle}`;
}

// ─── Counts from the model ───────────────────────────────────────────────

const sameVia = (row, via) => (row.via ?? NAME_ATTRIBUTE) === via;

export function ruleCounts(model, rule) {
  const via = ruleVia(rule);
  const row = rule.targetType === 'OrgEntity'
    ? (model?.entityLinks ?? []).find(l => l.fromType === rule.entityType && l.toType === rule.targetEntityType && sameVia(l, via))
    : (model?.links ?? []).find(l => l.entityType === rule.entityType && l.targetType === rule.targetType && sameVia(l, via));
  return row ? { accepted: Number(row.accepted) || 0, proposed: Number(row.proposed) || 0 } : null;
}

// "exact 80 + name 60 · 51 accepted · 9 proposed"; a rule without links yet
// shows its match only.
export function lineLabel(rule, counts) {
  const match = signalsSummary(rule.signals);
  if (!counts) return match;
  return `${match} · ${counts.accepted} accepted${counts.proposed ? ` · ${counts.proposed} proposed` : ''}`;
}

// ─── API calls ───────────────────────────────────────────────────────────

async function postJson(authFetch, path, body) {
  const r = await authFetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, ...payload };
  return {
    ok: false,
    error: payload.error || `HTTP ${r.status}`,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
  };
}

// POST /profiles/:id/relink { linkRules } → { ok, profile, run } or { ok: false, error, errors }.
export function relinkProfile(authFetch, profileId, linkRules) {
  return postJson(authFetch, `/profiles/${encodeURIComponent(profileId)}/relink`, { linkRules });
}

// POST /profiles/:id/rename-type { from, to } → { ok, profile, renamedEntities, otherProfiles } or { ok: false, error }.
export function renameEntityType(authFetch, profileId, from, to) {
  return postJson(authFetch, `/profiles/${encodeURIComponent(profileId)}/rename-type`, { from, to: to.trim() });
}

// A rename is worth sending when the new name is not empty and differs.
export function canRename(from, to) {
  const name = String(to ?? '').trim();
  return name.length > 0 && name !== from;
}
