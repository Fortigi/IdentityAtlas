// Organizational knowledge about people — the three kinds of claim the
// Authorization workbench groups people by (migration 106,
// docs/architecture/m1-discovery-and-design.md).
//
//   activity   performsActivity     the person performs a business activity
//   expertise  hasExpertise         the person knows a domain
//   duty       holdsResponsibility  a duty outside or across the daily work (works council, …)
//
// "duty", not "responsibility": the ContextRole "Responsible" is a different
// thing (who does the day-to-day for a unit or an application).
//
// Each kind names a canonical object: a Context of `contextType` under one root
// per kind (template Tag, people as members). One list for the claims check,
// the extraction prompt, the objects and the workbench.

export const KNOWLEDGE_KINDS = Object.freeze(['activity', 'expertise', 'duty']);

export const KNOWLEDGE = Object.freeze({
  activity: Object.freeze({ contextType: 'Activity', label: 'Activity', rootName: 'Activities', predicate: 'performsActivity' }),
  expertise: Object.freeze({ contextType: 'Expertise', label: 'Expertise', rootName: 'Expertise', predicate: 'hasExpertise' }),
  duty: Object.freeze({ contextType: 'Duty', label: 'Duty', rootName: 'Duties', predicate: 'holdsResponsibility' }),
});

export const isKnowledgeKind = (kind) => KNOWLEDGE_KINDS.includes(kind);

// An object is a name, not a sentence.
export const MAX_OBJECT_NAME = 200;

/** The name an object is matched by: case and spacing aside (what objects.js compares in SQL). Pure. */
export function objectKey(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The knowledge kind whose objects have this contextType, or null. Pure. */
export function kindOfContextType(contextType) {
  if (contextType === 'Activity') return 'activity';
  if (contextType === 'Expertise') return 'expertise';
  if (contextType === 'Duty') return 'duty';
  return null;
}
