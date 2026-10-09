// The wizard's draft: every edit, the readiness gates, the verdict and what the
// API receives. Inputs are chosen to discriminate: two entities so a removal
// that hits the wrong index shows, relations on both sides so a rename that
// misses one shows, a rule with two signals so a wrong-index removal shows.
import { describe, it, expect } from 'vitest';
import * as W from './wizardDraft';

const COLS = [{ name: 'ProjectCode' }, { name: 'ProjectName' }, { name: 'OwnerName' }, { name: 'OwnerEmail' }];
const SOURCE = { id: 's1', displayName: 'Projects', fileName: 'Projects.csv', observedAt: '2026-10-01', rowCount: 12, columns: COLS };
const PROJECT = { type: 'Project', nameColumn: 'ProjectName', keyColumn: 'ProjectCode', attributes: [] };
const OWNER = { type: 'Owner', nameColumn: 'OwnerName', keyColumn: '', attributes: [{ column: 'OwnerEmail', name: 'email' }] };
const RULE = {
  entityType: 'Owner', targetType: 'Principal', threshold: 50,
  signals: [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
  ],
};
const PROFILE = {
  id: 7, name: 'Projects', version: 3,
  recipe: { version: 1, entities: [PROJECT, OWNER], relations: [{ predicate: 'owner', from: 'Project', to: 'Owner' }] },
  linkRules: [{ ...RULE, threshold: 65 }],
};

function modelled() {
  return { ...W.setSource(W.emptyDraft(), SOURCE), recipe: structuredClone(PROFILE.recipe), linkRules: [structuredClone(RULE)] };
}

describe('emptyDraft / setMode / selectProfile', () => {
  it('starts a new import with nothing chosen', () => {
    const d = W.emptyDraft();
    expect(d).toMatchObject({ mode: 'new', profile: null, runMode: 'full', adjust: false, source: null, threshold: 50, profileName: '', quality: null, qualityStale: false });
    expect(d.recipe).toEqual({ version: 1, entities: [], relations: [] });
    expect(d.linkRules).toEqual([]);
  });

  it('prefills from a profile: recipe, rules, the rules’ threshold and the name', () => {
    const d = W.emptyDraft(PROFILE);
    expect(d.mode).toBe('repeat');
    expect(d.profile).toBe(PROFILE);
    expect(d.recipe).toBe(PROFILE.recipe);
    expect(d.linkRules).toBe(PROFILE.linkRules);
    expect(d.threshold).toBe(65);
    expect(d.profileName).toBe('Projects');
  });

  it('a profile without rules falls back to the default threshold and an empty recipe', () => {
    const d = W.selectProfile(W.emptyDraft(), { id: 1, name: 'Bare', version: 1 });
    expect(d.threshold).toBe(50);
    expect(d.recipe).toEqual({ version: 1, entities: [], relations: [] });
    expect(d.linkRules).toEqual([]);
  });

  it('selecting a profile drops measurements of the previous one', () => {
    const d = W.selectProfile({ ...W.emptyDraft(), detection: { X: [] }, quality: { rows: 1 } }, PROFILE);
    expect(d.detection).toEqual({});
    expect(d.quality).toBeNull();
  });

  it('switching back to new forgets the profile but keeps the source and run mode', () => {
    const d = W.setMode({ ...W.emptyDraft(PROFILE), source: SOURCE, runMode: 'delta' }, 'new');
    expect(d.mode).toBe('new');
    expect(d.profile).toBeNull();
    expect(d.recipe.entities).toEqual([]);
    expect(d.source).toBe(SOURCE);
    expect(d.runMode).toBe('delta');
    expect(W.setMode(W.emptyDraft(), 'repeat').mode).toBe('repeat');
  });
});

describe('latestProfiles', () => {
  it('keeps the highest version per name, sorted by name', () => {
    const list = [
      { id: 1, name: 'Projects', version: 1 }, { id: 2, name: 'Assets', version: 2 },
      { id: 3, name: 'Projects', version: 3 }, { id: 4, name: 'Projects', version: 2 }, { id: 5, name: 'Assets', version: 1 },
    ];
    expect(W.latestProfiles(list).map(p => p.id)).toEqual([2, 3]);
    expect(W.latestProfiles(null)).toEqual([]);
  });
});

describe('setSource / applyProposal', () => {
  it('a new source resets detection and quality but keeps the recipe', () => {
    const d = W.setSource({ ...modelled(), detection: { Owner: [1] }, quality: { rows: 1 } }, SOURCE);
    expect(d.source).toBe(SOURCE);
    expect(d.detection).toEqual({});
    expect(d.quality).toBeNull();
    expect(d.recipe.entities).toHaveLength(2);
    expect(W.columnNames(d)).toEqual(['ProjectCode', 'ProjectName', 'OwnerName', 'OwnerEmail']);
    expect(W.columnNames(W.emptyDraft())).toEqual([]);
  });

  it('takes the proposal and fills a missing threshold from the draft', () => {
    const base = { ...W.setThreshold(W.emptyDraft(), 70), quality: { rows: 1 } };
    const d = W.applyProposal(base, {
      recipe: PROFILE.recipe,
      linkRules: [{ ...RULE, threshold: undefined }, { ...RULE, entityType: 'Project', threshold: 40 }],
      origin: 'model', notes: ['OwnerEmail looks like an e-mail address'],
    });
    expect(d.recipe.entities.map(e => e.type)).toEqual(['Project', 'Owner']);
    expect(d.linkRules.map(r => r.threshold)).toEqual([70, 40]);
    expect(d.proposalOrigin).toBe('model');
    expect(d.notes).toEqual(['OwnerEmail looks like an e-mail address']);
    expect(d.quality).toBeNull();
  });

  it('a bare proposal defaults to heuristic with no notes and no rules', () => {
    const d = W.applyProposal(W.emptyDraft(), { recipe: { entities: [PROJECT] } });
    expect(d.proposalOrigin).toBe('heuristic');
    expect(d.notes).toEqual([]);
    expect(d.linkRules).toEqual([]);
    expect(d.recipe).toEqual({ version: 1, entities: [PROJECT], relations: [] });
  });
});

describe('entities', () => {
  it('adds a blank entity and clears the quality report', () => {
    const d = W.addEntity({ ...modelled(), quality: { rows: 1 } });
    expect(d.recipe.entities[2]).toEqual({ type: '', nameColumn: '', keyColumn: '', attributes: [] });
    expect(d.quality).toBeNull();
  });

  it('renaming a type renames it in relations, its rule and its detection', () => {
    const d = W.updateEntity({ ...modelled(), detection: { Owner: ['c'], Project: ['p'] } }, 1, { type: 'Manager' });
    expect(d.recipe.entities.map(e => e.type)).toEqual(['Project', 'Manager']);
    expect(d.recipe.relations).toEqual([{ predicate: 'owner', from: 'Project', to: 'Manager' }]);
    expect(d.linkRules[0].entityType).toBe('Manager');
    expect(d.detection).toEqual({ Manager: ['c'], Project: ['p'] });
  });

  it('renames the from side too, and leaves other rules alone', () => {
    const base = { ...modelled(), linkRules: [structuredClone(RULE), { ...structuredClone(RULE), entityType: 'Project' }] };
    const d = W.updateEntity(base, 0, { type: 'Programme' });
    expect(d.recipe.relations[0]).toEqual({ predicate: 'owner', from: 'Programme', to: 'Owner' });
    expect(d.linkRules.map(r => r.entityType)).toEqual(['Owner', 'Programme']);
  });

  it('typing the first type of a blank entity renames nothing', () => {
    const base = W.addEntity(modelled());
    const d = W.updateEntity({ ...base, recipe: { ...base.recipe, relations: [{ predicate: 'x', from: '', to: 'Owner' }] } }, 2, { type: 'Team' });
    expect(d.recipe.relations[0].from).toBe('');
    expect(d.recipe.entities[2].type).toBe('Team');
  });

  it('a patch without a type change keeps relations and rules as they were', () => {
    const base = modelled();
    const d = W.updateEntity(base, 0, { nameColumn: 'ProjectCode' });
    expect(d.recipe.entities[0]).toEqual({ ...PROJECT, nameColumn: 'ProjectCode' });
    expect(d.recipe.relations).toBe(base.recipe.relations);
    expect(d.linkRules).toBe(base.linkRules);
  });

  it('an index out of range changes nothing', () => {
    const base = modelled();
    expect(W.updateEntity(base, 5, { type: 'X' })).toBe(base);
    expect(W.removeEntity(base, 5)).toBe(base);
    expect(W.addAttribute(base, 5)).toBe(base);
  });

  it('removing an entity drops its relations, its rule and its detection, nothing else', () => {
    const base = {
      ...modelled(),
      recipe: { ...structuredClone(PROFILE.recipe), entities: [PROJECT, OWNER, { type: 'Team', nameColumn: 'ProjectName', attributes: [] }],
        relations: [{ predicate: 'owner', from: 'Project', to: 'Owner' }, { predicate: 'team', from: 'Project', to: 'Team' }, { predicate: 'lead', from: 'Owner', to: 'Team' }] },
      linkRules: [structuredClone(RULE), { ...structuredClone(RULE), entityType: 'Team' }],
      detection: { Owner: [1], Team: [2] },
    };
    const d = W.removeEntity(base, 1);
    expect(d.recipe.entities.map(e => e.type)).toEqual(['Project', 'Team']);
    expect(d.recipe.relations).toEqual([{ predicate: 'team', from: 'Project', to: 'Team' }]);
    expect(d.linkRules.map(r => r.entityType)).toEqual(['Team']);
    expect(d.detection).toEqual({ Team: [2] });
  });
});

describe('attributes', () => {
  it('adds, updates and removes by index', () => {
    let d = W.addAttribute(modelled(), 1);
    expect(d.recipe.entities[1].attributes).toEqual([{ column: 'OwnerEmail', name: 'email' }, { column: '', name: '' }]);
    d = W.updateAttribute(d, 1, 1, { column: 'OwnerName' });
    expect(d.recipe.entities[1].attributes[1]).toEqual({ column: 'OwnerName', name: '' });
    d = W.removeAttribute(d, 1, 0);
    expect(d.recipe.entities[1].attributes).toEqual([{ column: 'OwnerName', name: '' }]);
    expect(d.recipe.entities[0].attributes).toEqual([]);
  });

  it('works on an entity without an attributes array and ignores a bad attribute index', () => {
    const base = { ...modelled(), recipe: { ...modelled().recipe, entities: [{ type: 'X', nameColumn: 'A' }] } };
    expect(W.addAttribute(base, 0).recipe.entities[0].attributes).toEqual([{ column: '', name: '' }]);
    const d = W.updateAttribute(modelled(), 1, 4, { column: 'Z' });
    expect(d.recipe.entities[1].attributes).toEqual([{ column: 'OwnerEmail', name: 'email' }]);
  });

  it('entityAttributeNames: the name first, then name or column, no duplicates or blanks', () => {
    expect(W.entityAttributeNames({ attributes: [{ column: 'OwnerEmail', name: ' email ' }, { column: 'Budget' }, { column: 'B2', name: 'Budget' }, { column: '' }] }))
      .toEqual(['displayName', 'email', 'Budget']);
    expect(W.entityAttributeNames(undefined)).toEqual(['displayName']);
  });
});

describe('relations', () => {
  it('a new relation defaults to the first two defined types', () => {
    const d = W.addRelation(modelled());
    expect(d.recipe.relations[1]).toEqual({ predicate: '', from: 'Project', to: 'Owner' });
  });

  it('with one type both sides are that type; with none, empty', () => {
    const one = { ...modelled(), recipe: { version: 1, entities: [PROJECT, { ...OWNER, type: '' }], relations: [] } };
    expect(W.addRelation(one).recipe.relations[0]).toEqual({ predicate: '', from: 'Project', to: 'Project' });
    expect(W.addRelation(W.emptyDraft()).recipe.relations[0]).toEqual({ predicate: '', from: '', to: '' });
  });

  it('updates and removes by index; a bad index changes nothing', () => {
    let d = W.addRelation(modelled());
    d = W.updateRelation(d, 1, { predicate: 'sponsor' });
    expect(d.recipe.relations.map(r => r.predicate)).toEqual(['owner', 'sponsor']);
    expect(W.updateRelation(d, 9, { predicate: 'x' })).toBe(d);
    d = W.removeRelation(d, 0);
    expect(d.recipe.relations.map(r => r.predicate)).toEqual(['sponsor']);
  });
});

describe('link rules', () => {
  const emailCand = { attribute: 'email', targetType: 'Principal', targetField: 'email', type: 'exact', uniquePct: 94, suggestedWeight: 90 };
  const nameCand = { attribute: 'displayName', targetType: 'Principal', targetField: 'displayName', type: 'name', uniquePct: 61, suggestedWeight: 60 };

  it('accepting the first candidate creates the rule with the draft threshold', () => {
    const d = W.acceptCandidate(W.setThreshold(W.emptyDraft(), 40), 'Owner', emailCand);
    expect(d.linkRules).toEqual([{ entityType: 'Owner', targetType: 'Principal', threshold: 40, signals: [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 90 }] }]);
  });

  it('a second candidate is appended; the same one again only updates its weight', () => {
    let d = W.acceptCandidate(W.emptyDraft(), 'Owner', emailCand);
    d = W.acceptCandidate(d, 'Owner', nameCand);
    d = W.acceptCandidate(d, 'Owner', { ...emailCand, suggestedWeight: 95 });
    expect(d.linkRules[0].signals.map(s => [s.attribute, s.weight])).toEqual([['email', 95], ['displayName', 60]]);
  });

  it('a candidate for another target type moves the rule and keeps only fields that type allows', () => {
    const base = { ...W.emptyDraft(), linkRules: [structuredClone(RULE)] };
    const d = W.acceptCandidate(base, 'Owner', { attribute: 'email', targetType: 'Resource', targetField: 'mail', type: 'exact', suggestedWeight: 80 });
    expect(d.linkRules[0].targetType).toBe('Resource');
    expect(d.linkRules[0].signals.map(s => s.targetField)).toEqual(['displayName', 'mail']);
  });

  it('weights are clamped to 1..100 and default to 50', () => {
    expect(W.acceptCandidate(W.emptyDraft(), 'A', { ...emailCand, suggestedWeight: 250 }).linkRules[0].signals[0].weight).toBe(100);
    expect(W.acceptCandidate(W.emptyDraft(), 'A', { ...emailCand, suggestedWeight: undefined }).linkRules[0].signals[0].weight).toBe(50);
    expect(W.acceptCandidate(W.emptyDraft(), 'A', { ...emailCand, suggestedWeight: 0 }).linkRules[0].signals[0].weight).toBe(1);
  });

  it('refuses an eleventh signal but still updates an existing one at the limit', () => {
    const signals = Array.from({ length: 10 }, (_, i) => ({ attribute: `a${i}`, targetField: 'email', type: 'exact', weight: 10 }));
    const base = { ...W.emptyDraft(), linkRules: [{ entityType: 'A', targetType: 'Principal', threshold: 50, signals }] };
    expect(W.acceptCandidate(base, 'A', emailCand)).toBe(base);
    const d = W.acceptCandidate(base, 'A', { ...emailCand, attribute: 'a3', suggestedWeight: 77 });
    expect(d.linkRules[0].signals[3].weight).toBe(77);
  });

  it('accepting a candidate leaves the other rules in place and clears the quality report', () => {
    const base = { ...W.emptyDraft(), linkRules: [{ ...structuredClone(RULE), entityType: 'Project' }, structuredClone(RULE)], quality: { rows: 1 } };
    const d = W.acceptCandidate(base, 'Owner', { ...emailCand, attribute: 'phone' });
    expect(d.linkRules.map(r => [r.entityType, r.signals.length])).toEqual([['Project', 2], ['Owner', 3]]);
    expect(d.quality).toBeNull();
  });

  it('setRuleTarget keeps allowed signals, drops the rule when none remain, ignores unknown types', () => {
    const base = { ...W.emptyDraft(), linkRules: [structuredClone(RULE)] };
    expect(W.setRuleTarget(base, 'Owner', 'Context').linkRules[0].signals.map(s => s.targetField)).toEqual(['displayName']);
    const emailOnly = { ...W.emptyDraft(), linkRules: [{ ...structuredClone(RULE), signals: [RULE.signals[0]] }] };
    expect(W.setRuleTarget(emailOnly, 'Owner', 'Context').linkRules).toEqual([]);
    expect(W.setRuleTarget(base, 'Nobody', 'Context')).toBe(base);
    expect(W.setRuleTarget(base, 'Owner', 'Bogus').linkRules).toEqual([]);
  });

  it('updateSignal clamps the weight and only touches that signal', () => {
    const base = { ...W.emptyDraft(), linkRules: [structuredClone(RULE)] };
    expect(W.updateSignal(base, 'Owner', 1, { weight: '75' }).linkRules[0].signals.map(s => s.weight)).toEqual([90, 75]);
    expect(W.updateSignal(base, 'Owner', 0, { weight: '' }).linkRules[0].signals[0].weight).toBe(1);
    expect(W.updateSignal(base, 'Owner', 0, { type: 'prefix' }).linkRules[0].signals[0]).toEqual({ ...RULE.signals[0], type: 'prefix' });
    expect(W.updateSignal(base, 'Owner', 5, { weight: 3 })).toBe(base);
    expect(W.updateSignal(base, 'Nobody', 0, { weight: 3 })).toBe(base);
  });

  it('removeSignal removes by index and the last one removes the rule', () => {
    const base = { ...W.emptyDraft(), linkRules: [structuredClone(RULE)] };
    const d = W.removeSignal(base, 'Owner', 0);
    expect(d.linkRules[0].signals.map(s => s.attribute)).toEqual(['displayName']);
    expect(W.removeSignal(d, 'Owner', 0).linkRules).toEqual([]);
    expect(W.removeSignal(base, 'Owner', 2)).toBe(base);
    expect(W.removeSignal(base, 'Nobody', 0)).toBe(base);
  });

  it('candidateSentence reads like the handover example', () => {
    expect(W.candidateSentence('Owner', emailCand)).toBe('email matches 94 % unique on Principal.email');
    expect(W.candidateSentence('Owner', { ...nameCand, uniquePct: 60.6 })).toBe('Owner name matches 61 % unique on Principal.displayName');
    expect(W.candidateSentence('Owner', { ...nameCand, uniquePct: undefined })).toBe('Owner name matches 0 % unique on Principal.displayName');
  });

  it('setDetection stores candidates per type without touching others', () => {
    const d = W.setDetection({ ...W.emptyDraft(), detection: { A: [1] } }, 'B', [2]);
    expect(d.detection).toEqual({ A: [1], B: [2] });
  });
});

describe('threshold and quality', () => {
  it('writes the clamped threshold into every rule and marks an existing report stale', () => {
    const base = { ...W.emptyDraft(), linkRules: [structuredClone(RULE), { ...structuredClone(RULE), entityType: 'P', threshold: 10 }], quality: { rows: 1 } };
    const d = W.setThreshold(base, '85');
    expect(d.threshold).toBe(85);
    expect(d.linkRules.map(r => r.threshold)).toEqual([85, 85]);
    expect(d.qualityStale).toBe(true);
    expect(W.setThreshold(base, 140).threshold).toBe(100);
    expect(W.setThreshold(base, -5).threshold).toBe(0);
    expect(W.setThreshold(W.emptyDraft(), 60).qualityStale).toBe(false);
    expect(W.setQuality(d, { rows: 2 })).toMatchObject({ quality: { rows: 2 }, qualityStale: false });
  });

  it('linkShares are whole percentages of the three counts, zero when empty', () => {
    expect(W.linkShares({ unique: 51, ambiguous: 3, none: 6 })).toEqual({ unique: 85, ambiguous: 5, none: 10 });
    expect(W.linkShares({ unique: 0, ambiguous: 0, none: 0 })).toEqual({ unique: 0, ambiguous: 0, none: 0 });
    expect(W.linkShares(undefined)).toEqual({ unique: 0, ambiguous: 0, none: 0 });
    expect(W.linkShares({ unique: 1 })).toEqual({ unique: 100, ambiguous: 0, none: 0 });
  });
});

describe('qualityVerdict', () => {
  it('blocks without a report', () => {
    expect(W.qualityVerdict(null, 50)).toEqual({ canStart: false, warnings: [], blockers: ['Run the data-quality check first.'] });
  });

  it('blocks when a linked type has no unique match at all', () => {
    const v = W.qualityVerdict({ links: { Owner: { total: 10, unique: 0, ambiguous: 2, none: 8 }, Project: { total: 5, unique: 5, none: 0 } } }, 50);
    expect(v.canStart).toBe(false);
    expect(v.blockers).toHaveLength(1);
    expect(v.blockers[0]).toMatch(/^No Owner matched uniquely/);
    expect(v.warnings).toEqual([]);
  });

  it('warns, but lets the run start, when more entries have no match than a unique one', () => {
    const v = W.qualityVerdict({ links: { Owner: { unique: 4, none: 5 } } }, 50);
    expect(v.canStart).toBe(true);
    expect(v.warnings).toEqual(['More Owner entries have no match (5) than a unique one (4).']);
  });

  it('does not warn when none equals unique', () => {
    expect(W.qualityVerdict({ links: { Owner: { unique: 5, none: 5 } } }, 50).warnings).toEqual([]);
  });

  it('warns about duplicate and empty keys, closures and a weak threshold, with singulars', () => {
    const v = W.qualityVerdict({
      entities: { Project: { duplicateKeys: 2, emptyKeys: 1 }, Owner: { duplicateKeys: 1, emptyKeys: 0 } },
      wouldClose: { Project: 4, Owner: 1, Team: 0 },
    }, 25);
    expect(v.canStart).toBe(true);
    expect(v.warnings).toEqual([
      'Project has 2 duplicate keys; the first row wins.',
      'Project has 1 row without a key; those are skipped.',
      'Owner has 1 duplicate key; the first row wins.',
      'A full import closes 4 Project entries the new list no longer contains.',
      'A full import closes 1 Owner entry the new list no longer contains.',
      'A threshold of 25 links on weak evidence; most links will need review.',
    ]);
    expect(W.qualityVerdict({ entities: { P: { emptyKeys: 3 } } }, 30).warnings).toEqual(['P has 3 rows without a key; those are skipped.']);
  });
});

describe('recipeProblems / staleColumns', () => {
  it('a complete recipe has no problems', () => {
    expect(W.recipeProblems(modelled())).toEqual([]);
  });

  it('names every problem an editor can make', () => {
    const d = { ...modelled(), recipe: { version: 1,
      entities: [PROJECT, { ...PROJECT, nameColumn: ' ' }, { type: ' ', nameColumn: 'X' }],
      relations: [{ predicate: '', from: 'Project', to: 'Project' }, { predicate: 'p', from: 'Project', to: 'Ghost' }, { predicate: 'q', from: '', to: 'Project' }] } };
    expect(W.recipeProblems(d)).toEqual([
      'Entity type "Project" is defined more than once.',
      'Entity 2 has no name column.',
      'Entity 3 has no type.',
      'Relation 1 has no predicate.',
      'Relation 2 refers to an entity type the recipe does not define.',
      'Relation 3 refers to an entity type the recipe does not define.',
    ]);
    expect(W.recipeProblems(W.emptyDraft())).toEqual(['Add at least one entity.']);
  });

  it('lists each column the recipe uses that the source lacks, once', () => {
    const d = { ...modelled(), source: { ...SOURCE, columns: [{ name: 'ProjectName' }, { name: 'OwnerName' }] } };
    expect(W.staleColumns(d)).toEqual(['ProjectCode', 'OwnerEmail']);
    const twice = { ...d, recipe: { ...d.recipe, entities: [...d.recipe.entities, { type: 'X', nameColumn: 'OwnerEmail' }] } };
    expect(W.staleColumns(twice)).toEqual(['ProjectCode', 'OwnerEmail']);
    expect(W.staleColumns(modelled())).toEqual([]);
    expect(W.staleColumns({ ...modelled(), source: null })).toEqual([]);
  });
});

describe('stepReady and navigation', () => {
  it('1: a new import may go on; a repeat needs a profile', () => {
    expect(W.stepReady(1, W.emptyDraft())).toBe(true);
    expect(W.stepReady(1, W.setMode(W.emptyDraft(), 'repeat'))).toBe(false);
    expect(W.stepReady(1, W.emptyDraft(PROFILE))).toBe(true);
  });

  it('2: needs a source; 3: needs a sound recipe; 4: always', () => {
    expect(W.stepReady(2, W.emptyDraft())).toBe(false);
    expect(W.stepReady(2, modelled())).toBe(true);
    expect(W.stepReady(3, W.emptyDraft())).toBe(false);
    expect(W.stepReady(3, modelled())).toBe(true);
    expect(W.stepReady(4, W.emptyDraft())).toBe(true);
  });

  it('5: needs a fresh report whose verdict lets the run start', () => {
    const ok = W.setQuality(modelled(), { links: { Owner: { unique: 3, none: 0 } } });
    expect(W.stepReady(5, ok)).toBe(true);
    expect(W.stepReady(5, modelled())).toBe(false);
    expect(W.stepReady(5, W.setThreshold(ok, 70))).toBe(false);
    expect(W.stepReady(5, W.setQuality(modelled(), { links: { Owner: { unique: 0, none: 3 } } }))).toBe(false);
  });

  it('6: needs a profile name; any other step is never ready', () => {
    expect(W.stepReady(6, modelled())).toBe(false);
    expect(W.stepReady(6, { ...modelled(), profileName: '  ' })).toBe(false);
    expect(W.stepReady(6, { ...modelled(), profileName: 'Projects' })).toBe(true);
    expect(W.stepReady(7, modelled())).toBe(false);
  });

  it('skips the model step in a repeat unless adjusting', () => {
    const repeat = W.emptyDraft(PROFILE);
    expect(W.modelStepShown(repeat)).toBe(false);
    expect(W.nextStep(2, repeat)).toBe(4);
    expect(W.prevStep(4, repeat)).toBe(2);
    const adjust = { ...repeat, adjust: true };
    expect(W.modelStepShown(adjust)).toBe(true);
    expect(W.nextStep(2, adjust)).toBe(3);
    expect(W.prevStep(4, adjust)).toBe(3);
    expect(W.nextStep(2, W.emptyDraft())).toBe(3);
    expect(W.nextStep(4, repeat)).toBe(5);
    expect(W.prevStep(6, repeat)).toBe(5);
  });
});

describe('what the API receives', () => {
  it('recipeForApi trims, drops an empty key column and blank attributes, omits a blank attribute name', () => {
    const recipe = { version: 1,
      entities: [{ type: ' Owner ', nameColumn: 'OwnerName', keyColumn: '', attributes: [{ column: 'OwnerEmail', name: ' email ' }, { column: 'Phone', name: '' }, { column: '', name: 'x' }] },
        { type: 'Project', nameColumn: 'ProjectName', keyColumn: 'ProjectCode' }],
      relations: [{ predicate: ' owner ', from: ' Project', to: 'Owner ' }] };
    expect(W.recipeForApi(recipe)).toEqual({ version: 1,
      entities: [{ type: 'Owner', nameColumn: 'OwnerName', attributes: [{ column: 'OwnerEmail', name: 'email' }, { column: 'Phone' }] },
        { type: 'Project', nameColumn: 'ProjectName', keyColumn: 'ProjectCode', attributes: [] }],
      relations: [{ predicate: 'owner', from: 'Project', to: 'Owner' }] });
  });

  it('proposeBody sends the column profile, the file name and a whole row count', () => {
    expect(W.proposeBody(modelled())).toEqual({ fileName: 'Projects.csv', columns: COLS, rowCount: 12 });
    expect(W.proposeBody({ ...modelled(), source: { ...SOURCE, fileName: '', rowCount: null } })).toEqual({ fileName: 'Projects', columns: COLS });
    expect(W.proposeBody({ ...modelled(), source: { id: 'x', rowCount: 2.5 } })).toEqual({ fileName: '', columns: [] });
    expect(W.proposeBody(W.emptyDraft())).toEqual({ fileName: '', columns: [] });
  });

  it('columnNamesOnly when the model is not configured or not available', () => {
    expect(W.columnNamesOnly({ configured: false, available: true })).toBe(true);
    expect(W.columnNamesOnly({ configured: true, available: false })).toBe(true);
    expect(W.columnNamesOnly({ configured: true, available: true })).toBe(false);
    expect(W.columnNamesOnly({})).toBe(false);
    expect(W.columnNamesOnly(null)).toBe(false);
  });

  it('profileBody and dryRunBody', () => {
    const d = { ...modelled(), profileName: ' Projects ', runMode: 'delta' };
    expect(W.profileBody(d)).toEqual({ name: 'Projects', sourceKind: 'list', recipe: W.recipeForApi(d.recipe), linkRules: d.linkRules });
    expect(W.dryRunBody(d)).toEqual({ sourceId: 's1', recipe: W.recipeForApi(d.recipe), linkRules: d.linkRules, mode: 'delta' });
    expect(W.dryRunBody(W.emptyDraft()).sourceId).toBeUndefined();
  });

  it('profileAction: create, reuse when unchanged, version when adjusted or changed', () => {
    expect(W.profileAction(W.emptyDraft())).toBe('create');
    expect(W.profileAction(W.setMode(W.emptyDraft(), 'repeat'))).toBe('create');
    const repeat = W.emptyDraft(PROFILE);
    expect(W.profileAction(repeat)).toBe('reuse');
    expect(W.profileAction({ ...repeat, adjust: true })).toBe('version');
    expect(W.profileAction(W.setThreshold(repeat, 80))).toBe('version');
    expect(W.profileAction(W.updateRelation(repeat, 0, { predicate: 'lead' }))).toBe('version');
    expect(W.profileAction(W.selectProfile(W.emptyDraft(), { id: 2, name: 'Bare', version: 1 }))).toBe('reuse');
  });

  it('profileLine says what step 6 will do with the profile', () => {
    expect(W.profileLine(W.emptyDraft())).toBeNull();
    expect(W.profileLine(W.emptyDraft(PROFILE))).toBe('Uses Projects version 3.');
    expect(W.profileLine({ ...W.emptyDraft(PROFILE), adjust: true })).toBe('Saves version 4 of Projects.');
    expect(W.profileLine({ ...W.selectProfile(W.emptyDraft(), { id: 2, name: 'Bare' }), adjust: true })).toBe('Saves version 1 of Bare.');
  });
});
