import { describe, it, expect } from 'vitest';
import {
  validateRecipe, validateLinkRules, normalizeRecipe, normalizeLinkRules, ruleVia, ruleName,
  entityAttributeNames, LINK_TARGETS, SIGNAL_TYPES, LIMITS, RECIPE_JSON_SCHEMA, LINK_RULES_JSON_SCHEMA,
} from './contracts.js';

const COLUMNS = ['ProjectCode', 'ProjectName', 'Budget', 'OwnerName', 'OwnerEmail'];

const recipe = () => ({
  version: 1,
  entities: [
    { type: 'Project', keyColumn: 'ProjectCode', nameColumn: 'ProjectName', attributes: [{ column: 'Budget', name: 'budget' }] },
    { type: 'Person', nameColumn: 'OwnerName', attributes: [{ column: 'OwnerEmail', name: 'email' }] },
  ],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
});

const rules = () => ([{
  entityType: 'Person', targetType: 'Principal', threshold: 50,
  signals: [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
  ],
}]);

describe('validateRecipe', () => {
  it('accepts the reference recipe against its columns', () => {
    expect(validateRecipe(recipe(), COLUMNS)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a non-object and says what it expected', () => {
    expect(validateRecipe(null).errors).toEqual(['The recipe must be an object with "entities" and "relations".']);
    expect(validateRecipe([]).ok).toBe(false);
  });

  it('names the column the source does not have', () => {
    const r = recipe();
    r.entities[0].attributes[0].column = 'Budgte';
    const { ok, errors } = validateRecipe(r, COLUMNS);
    expect(ok).toBe(false);
    expect(errors).toEqual(['Entity "Project" attribute refers to column "Budgte", which the source does not have.']);
  });

  it('does not check columns when none are given', () => {
    const r = recipe();
    r.entities[0].nameColumn = 'Anything';
    expect(validateRecipe(r).ok).toBe(true);
  });

  it('rejects a relation whose side the recipe does not define', () => {
    const r = recipe();
    r.relations.push({ predicate: 'costCenter', from: 'Project', to: 'CostCenter' });
    expect(validateRecipe(r, COLUMNS).errors).toEqual([
      'Relation 2 refers to entity type "CostCenter", which the recipe does not define.',
    ]);
  });

  it('rejects duplicate entity types, duplicate attribute names and duplicate relations', () => {
    const r = recipe();
    r.entities.push({ type: 'Person', nameColumn: 'OwnerName' });
    r.entities[0].attributes.push({ column: 'Budget' , name: 'budget' });
    r.relations.push({ predicate: 'owner', from: 'Project', to: 'Person' });
    const { errors } = validateRecipe(r, COLUMNS);
    expect(errors).toContain('Entity type "Person" is defined more than once.');
    expect(errors).toContain('Entity "Project" maps attribute "budget" twice.');
    expect(errors).toContain('Relation 2 (owner: Project → Person) is defined more than once.');
  });

  it('treats the entity name as a reserved attribute', () => {
    const r = recipe();
    r.entities[1].attributes.push({ column: 'OwnerName', name: 'displayName' });
    expect(validateRecipe(r, COLUMNS).errors).toEqual(['Entity "Person" maps attribute "displayName" twice.']);
  });

  it('requires version 1, a type, a nameColumn and a non-empty keyColumn', () => {
    const r = recipe();
    r.version = 2;
    r.entities[0].keyColumn = '  ';
    r.entities[1] = { nameColumn: 'OwnerName' };
    const { errors } = validateRecipe(r, COLUMNS);
    expect(errors).toContain('The recipe "version" must be 1.');
    expect(errors).toContain('Entity "Project" has an empty "keyColumn".');
    expect(errors).toContain('Entity 2 has no "type".');
    expect(errors).toContain('Relation 1 refers to entity type "Person", which the recipe does not define.');
  });

  it('enforces the caps with the actual numbers', () => {
    const r = recipe();
    r.entities = Array.from({ length: LIMITS.entities + 1 }, (_, i) => ({ type: `T${i}`, nameColumn: 'ProjectName' }));
    r.relations = [];
    expect(validateRecipe(r, COLUMNS).errors).toEqual([`The recipe has ${LIMITS.entities + 1} entities; the maximum is ${LIMITS.entities}.`]);
  });
});

describe('validateLinkRules', () => {
  it('accepts the reference rules against the recipe', () => {
    expect(validateLinkRules(rules(), recipe())).toEqual({ ok: true, errors: [] });
  });

  it('rejects an attribute the entity does not have, listing what it has', () => {
    const rs = rules();
    rs[0].signals[0].attribute = 'mail';
    expect(validateLinkRules(rs, recipe()).errors).toEqual([
      'Link rule 1 ("Person") signal 1 uses attribute "mail", which entity "Person" does not have (have: displayName, email).',
    ]);
  });

  it('rejects a target field the target type does not allow', () => {
    const rs = rules();
    rs[0].targetType = 'Context';
    const { errors } = validateLinkRules(rs, recipe());
    expect(errors).toEqual([
      'Link rule 1 ("Person") signal 1 targets field "email"; Context allows displayName.',
    ]);
  });

  it('rejects an unknown target type, a bad threshold, a bad signal type and a bad weight', () => {
    const rs = rules();
    rs.push({ entityType: 'Project', targetType: 'System', signals: [] });
    rs[0].threshold = 101;
    rs[0].signals[1].type = 'fuzzy';
    rs[0].signals[1].weight = 0;
    const { errors } = validateLinkRules(rs, recipe());
    expect(errors).toContain('Link rule 2 ("Project") has an unknown targetType "System"; use one of Principal, Identity, Resource, Context.');
    expect(errors).toContain('Link rule 1 ("Person") threshold must be a whole number from 0 to 100.');
    expect(errors).toContain(`Link rule 1 ("Person") signal 2 has type "fuzzy"; use one of ${SIGNAL_TYPES.join(', ')}.`);
    expect(errors).toContain('Link rule 1 ("Person") signal 2 weight must be a whole number from 1 to 100.');
  });

  it('allows several rules per entity type (per target type and attribute), but not the same one twice', () => {
    const rs = [...rules(), ...rules()];
    rs[1].entityType = 'Person';
    // a second rule through another attribute, and one to another target type, are fine
    rs.push({ entityType: 'Person', targetType: 'Principal', via: 'displayName', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 }] });
    rs.push({ entityType: 'Person', targetType: 'Resource', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'exact', weight: 90 }] });
    rs.push({ entityType: 'Asset', targetType: 'Resource', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'exact', weight: 90 }] });
    const { errors } = validateLinkRules(rs, recipe());
    expect(errors).toEqual([
      'Link rule 2 repeats Person → Principal via email; one rule per attribute and target type.',
      'Link rule 5 is for entity type "Asset", which the recipe does not define.',
    ]);
  });

  it('rejects an empty via, or one the entity does not have; via defaults to the first signal\'s attribute', () => {
    const rs = rules();
    rs[0].via = 'mail';
    expect(validateLinkRules(rs, recipe()).errors).toEqual([
      'Link rule 1 ("Person") links via "mail", which entity "Person" does not have (have: displayName, email).',
    ]);
    rs[0].via = ' ';
    expect(validateLinkRules(rs, recipe()).errors).toEqual(['Link rule 1 ("Person") has an empty "via".']);
    expect(ruleVia({ signals: [{ attribute: 'team' }] })).toBe('team');
    expect(ruleVia({ signals: [] })).toBe('displayName');
    expect(ruleName({ entityType: ' Project ', targetType: 'Resource', signals: [] })).toBe('Project → Resource via displayName');
  });

  it('a nameAttribute exposes the name under a second attribute name and may not collide', () => {
    const r = recipe();
    r.entities[0].nameAttribute = 'klant';
    expect(validateRecipe(r, COLUMNS).ok).toBe(true);
    expect(entityAttributeNames(r.entities[0])).toEqual(['displayName', 'klant', 'budget']);
    expect(normalizeRecipe(r).entities[0].nameAttribute).toBe('klant');
    r.entities[0].attributes.push({ column: 'Budget', name: 'klant' });
    expect(validateRecipe(r, COLUMNS).errors).toEqual(['Entity "Project" maps attribute "klant" twice.']);
    r.entities[0].attributes.pop();
    r.entities[0].nameAttribute = '';
    expect(validateRecipe(r, COLUMNS).errors).toEqual(['Entity "Project" has an empty "nameAttribute".']);
    r.entities[0].nameAttribute = 'displayName';
    expect(normalizeRecipe(r).entities[0].nameAttribute).toBeUndefined();
  });

  it('validates without a recipe (attributes unchecked, everything else checked)', () => {
    const rs = rules();
    rs[0].signals[0].attribute = 'whatever';
    expect(validateLinkRules(rs).ok).toBe(true);
    expect(validateLinkRules('nope').errors).toEqual(['Link rules must be an array.']);
  });
});

describe('normalize*', () => {
  it('fills keyColumn, attribute names, trims types and predicates', () => {
    const r = recipe();
    r.entities[1].type = ' Person ';
    r.entities[1].attributes = [{ column: 'OwnerEmail' }];
    r.relations[0].to = 'Person ';
    const n = normalizeRecipe(r);
    expect(n.entities[1]).toEqual({ type: 'Person', nameColumn: 'OwnerName', keyColumn: 'OwnerName', attributes: [{ column: 'OwnerEmail', name: 'OwnerEmail' }] });
    expect(n.entities[0].keyColumn).toBe('ProjectCode');
    expect(n.relations[0]).toEqual({ predicate: 'owner', from: 'Project', to: 'Person' });
  });

  it('fills threshold 50, via, the rule name, a signal name and the signal order', () => {
    const n = normalizeLinkRules([{ entityType: 'Person', targetType: 'Principal', signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }]);
    expect(n[0].threshold).toBe(50);
    expect(n[0].via).toBe('email');
    expect(n[0].name).toBe('Person → Principal via email');
    expect(n[0].signals[0]).toEqual({ name: 'email→email', attribute: 'email', targetField: 'email', type: 'exact', weight: 90, order: 0 });
  });

  it('entityAttributeNames lists the name first and de-duplicates', () => {
    expect(entityAttributeNames({ attributes: [{ column: 'A' }, { column: 'B', name: 'b' }, { column: 'C', name: 'b' }] })).toEqual(['displayName', 'A', 'b']);
    expect(entityAttributeNames(undefined)).toEqual(['displayName']);
  });
});

describe('the JSON schemas mirror the validators', () => {
  it('allow exactly the link targets and signal types the validator allows', () => {
    expect(LINK_RULES_JSON_SCHEMA.items.properties.targetType.enum).toEqual(Object.keys(LINK_TARGETS));
    expect(LINK_RULES_JSON_SCHEMA.items.properties.signals.items.properties.type.enum).toEqual(SIGNAL_TYPES);
    expect(RECIPE_JSON_SCHEMA.properties.entities.maxItems).toBe(LIMITS.entities);
    expect(RECIPE_JSON_SCHEMA.properties.relations.maxItems).toBe(LIMITS.relations);
  });
});
