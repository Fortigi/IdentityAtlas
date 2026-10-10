// Organisation truth — the link rules the templates generate instead of the analyst.
//
//   referenceRule({ entityType, via, targetType, targetEntityType? }) → a (not yet normalised) link rule
//   relationLinkRules(recipe)          → the two normalised rules of a relation recipe ('left', 'right')
//   activityKeyRules(recipe, role)     → the normalised rules that resolve an activity's actor / subject values
//   KEY_ENTITY_TYPE                    the entityType an activity key is scored as
//
// A reference is one cell value naming one thing ("Ann Example", "Contoso",
// "SG_Finance_Read"); the signals per target type are the ones that can find it
// by that value. Fuzzy is on everywhere a name can be written several ways:
// "PortOfRotterdam" ↔ "Port of Rotterdam", "Ann Exampel" ↔ "Ann Example".
import { normalizeLinkRules } from './contracts.js';
import { relationEntityDef } from './templateContracts.js';

export const REFERENCE_THRESHOLD = 60;
// Never the type of an organisation list: a key is not an entity (buildRuleIndex
// leaves a rule's own entity type out of OrgEntity targets).
export const KEY_ENTITY_TYPE = '\u0000activityKey';

// Named "<field> <type>" ("displayName fuzzy"): several signals read the same attribute,
// and the default name (attribute→field) would repeat.
const signal = (attribute, targetField, type, weight) => ({ name: `${targetField} ${type}`, attribute, targetField, type, weight });

function signalsFor(targetType, via) {
  switch (targetType) {
    case 'Principal':
    case 'Identity':
      return [signal(via, 'email', 'exact', 90), signal(via, 'displayName', 'exact', 80), signal(via, 'displayName', 'name', 60), signal(via, 'displayName', 'fuzzy', 70)];
    case 'Resource':
      return [signal(via, 'displayName', 'exact', 90), signal(via, 'externalId', 'exact', 90), signal(via, 'displayName', 'fuzzy', 60)];
    default: // OrgEntity
      return [signal(via, 'displayName', 'fuzzy', 100)];
  }
}

export function referenceRule({ entityType, via, targetType, targetEntityType }) {
  return {
    entityType, targetType, via, threshold: REFERENCE_THRESHOLD,
    ...(targetType === 'OrgEntity' && targetEntityType ? { targetEntityType } : {}),
    signals: signalsFor(targetType, via),
  };
}

export function relationLinkRules(recipe) {
  const def = relationEntityDef(recipe.relation);
  return normalizeLinkRules(['left', 'right'].map(end => referenceRule({ entityType: def.type, via: end, ...recipe.relation[end] })));
}

/** The target types one role of an activity recipe resolves to, in order of preference. */
export function roleTargets(recipe, role) {
  const a = recipe.activity;
  if (role === 'actor') return a.actor.targetTypes.map(targetType => ({ targetType }));
  return [{ targetType: a.subject.targetType, targetEntityType: a.subject.targetEntityType }];
}

export function activityKeyRules(recipe, role) {
  return normalizeLinkRules(roleTargets(recipe, role).map(t => referenceRule({ entityType: KEY_ENTITY_TYPE, via: 'displayName', ...t })));
}
