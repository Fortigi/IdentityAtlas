// Pure logic behind the per-link table (OrgLinkTable) on the org-entity detail
// page: one normalised candidate row per link, and the Move choice.
//
// A link is read either flat ({ id, targetType, targetId, label, confidence,
// signals }, as GET /entities/:id sends it) or nested ({ link, target }).
// Review works on distinct decision groups instead (reviewGroups.js).
import { splitSignals } from './orgFormat';

function toCandidate(x) {
  const link = x?.link || x || {};
  const target = x?.target || {};
  return {
    linkId: link.id,
    targetType: target.targetType ?? link.targetType ?? null,
    targetId: target.id ?? link.targetId ?? null,
    label: target.label ?? link.label ?? link.targetId ?? '(unknown)',
    confidence: link.confidence == null ? null : Number(link.confidence),
    signals: splitSignals(link.signals),
    status: link.status ?? null,
    override: link.analystOverride ?? null,
    matchedField: link.matchedField ?? null,
    matchedValue: link.matchedValue ?? null,
  };
}

function byConfidenceDesc(a, b) {
  return ((b.confidence ?? -1) - (a.confidence ?? -1)) || String(a.label).localeCompare(String(b.label));
}

// The flat `links` of GET /entities/:id as the same candidate rows, best first.
export function toLinkCandidates(links) {
  return (links || []).map(toCandidate).filter(c => c.linkId != null).sort(byConfidenceDesc);
}

// The candidates a link may be moved to: the other targets of the same type
// shown for that entity (the API moves within one targetType).
export function moveOptions(candidates, linkId) {
  const self = (candidates || []).find(c => c.linkId === linkId);
  return (candidates || []).filter(c =>
    c.linkId !== linkId && c.targetId != null && (!self || c.targetType === self.targetType));
}

export function movePromptMessage(options) {
  const lines = options.map((c, i) => `${i + 1}. ${c.label}${c.confidence != null ? ` (${c.confidence}%)` : ''}`);
  return `Move this link to which candidate? Type its number or its name.\n${lines.join('\n')}`;
}

// The option the analyst typed: a 1-based number or a name (case-insensitive).
export function pickMoveOption(input, options) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return options[Number(text) - 1] || null;
  const lower = text.toLowerCase();
  return options.find(c => String(c.label).toLowerCase() === lower) || null;
}
