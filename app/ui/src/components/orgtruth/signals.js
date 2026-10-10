// Pure helpers for Organisation → Signals: what activity says about a
// collection type (inactive customers, customers marked inactive but still
// worked on, people working on one without being a member, members without
// activity), and the per-type settings behind those findings.
//
//   GET /api/org-truth/signals?type=<collection type>
//     → { type, settings, asOf, findings: { inactive, markedInactiveButActive,
//                                            activeWithoutMembership, memberWithoutActivity } }
//   GET/PUT /api/org-truth/signals/settings
//     → { [collectionType]: { inactiveAfterMonths, statusAttribute, inactiveValues } }
//
// Kept apart from the .jsx so it is mutated (stryker.orgtruth.config.json).
import { isCollectionTemplate } from './orgFormat';
import { formatMeasure, formatOn, refDetailKind } from './activity';

export const SIGNALS_URL = '/api/org-truth/signals';
export const SETTINGS_URL = '/api/org-truth/signals/settings';
export const DEFAULT_MONTHS = 6;
export const MAX_MONTHS = 120;

export const FINDING_KINDS = [
  { key: 'inactive', title: 'Inactive', hint: 'No activity within the period.' },
  { key: 'markedInactiveButActive', title: 'Marked inactive but still active', hint: 'The list says inactive; the activity says otherwise.' },
  { key: 'activeWithoutMembership', title: 'Active without being a member', hint: 'People with activity on it who are not listed as a member.' },
  { key: 'memberWithoutActivity', title: 'Member without activity', hint: 'Listed members with no activity on it.' },
];

// The collection types of the model (enrichment / activity / relation types
// are not collections), the ones an activity is about first.
export function collectionTypes(model) {
  const subjects = new Set((model?.activities ?? []).map(a => a.subjectEntityType).filter(Boolean));
  const types = (model?.entityTypes ?? []).filter(t => isCollectionTemplate(t.template)).map(t => t.type);
  return [...types.filter(t => subjects.has(t)), ...types.filter(t => !subjects.has(t))];
}

// The attribute keys a type's status may live in (the current choice kept).
export function statusAttributeOptions(model, type, current) {
  const keys = (model?.entityTypes ?? []).find(t => t.type === type)?.attributeKeys ?? [];
  const all = current && !keys.includes(current) ? [...keys, current] : keys;
  return [...all].sort((a, b) => a.localeCompare(b));
}

export function findingsOf(data, key) {
  const rows = data?.findings?.[key];
  return Array.isArray(rows) ? rows : [];
}

const entityRef = (row) => ({ kind: 'org-entity', id: row.entityId, label: row.label });
const personRef = (p) => (p ? { kind: refDetailKind(p.targetType), id: p.targetId, label: p.label } : null);
const lastText = (on) => (on ? `last activity ${formatOn(on)}` : 'no activity recorded');

const DETAIL = {
  inactive: (r) => (r.lastActivityOn ? `${lastText(r.lastActivityOn)} · ${r.monthsSince} months ago` : lastText(null)),
  markedInactiveButActive: (r) => `marked “${r.statusValue}” · ${lastText(r.lastActivityOn)}`,
  activeWithoutMembership: (r) => `${formatMeasure(r.total)} · ${lastText(r.lastOn)}`,
  memberWithoutActivity: (r) => [r.role, lastText(r.lastOn)].filter(Boolean).join(' · '),
};

// One display row per finding: the entity, the person it concerns (two of the
// four kinds name one) and a sentence.
export function findingRows(key, rows) {
  const detail = DETAIL[key] ?? (() => '');
  return (rows ?? []).map((r, i) => {
    const person = personRef(r.actor ?? r.member);
    return { key: `${r.entityId}|${person?.id ?? ''}|${i}`, entity: entityRef(r), person, detail: detail(r) };
  });
}

// The settings panel's text fields from the stored settings of one type.
export function settingsDraft(settings) {
  return {
    months: String(settings?.inactiveAfterMonths ?? DEFAULT_MONTHS),
    statusAttribute: settings?.statusAttribute ?? '',
    inactiveValues: (settings?.inactiveValues ?? []).join(', '),
  };
}

// A sentence when the draft cannot be saved, else null.
export function settingsError(draft) {
  const text = String(draft?.months ?? '').trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > MAX_MONTHS) return `The period must be a whole number of months from 1 to ${MAX_MONTHS}.`;
  return null;
}

export function splitValues(text) {
  return [...new Set(String(text ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}

// The PUT body: every type's settings, with this type's replaced. Inactive
// values only mean something with a status attribute.
export function settingsBody(all, type, draft) {
  const statusAttribute = draft.statusAttribute.trim() || null;
  return {
    ...(all ?? {}),
    [type]: {
      inactiveAfterMonths: Number(draft.months.trim()),
      statusAttribute,
      inactiveValues: statusAttribute ? splitValues(draft.inactiveValues) : [],
    },
  };
}

// "As of" line: the findings are measured against the latest activity in the
// data, not today, so an old export still reads sensibly.
export function asOfText(data) {
  if (!data?.asOf) return 'No activity has been imported for this type yet.';
  return `Measured against the latest activity in the data: ${formatOn(data.asOf)}.`;
}
