// context-recipe plugin — builds the context tree an analyst designed in the context
// assistant (see contexts/recipe/ and docs/architecture/context-assistant.md).
//
// The recipe is the run's parameters, so the runner's refresh after every crawl
// re-applies it to current data: a new group whose name matches a kept term joins the
// context, an excluded one stays out. No model is involved at run time.
//
// Structure:
//   flat    one context holding every member
//   byTerm  a root, with one child per kept term that finds something, and an
//           "Added by hand" child for included objects no kept term finds. An object
//           found by two terms sits in both children; filtering on the root includes
//           the children.
//
// Hidden from the generic "Run a plugin" picker: a recipe is built in the assistant.

import { tx } from '../../db/connection.js';
import { validateRecipe } from '../recipe/recipe.js';
import { computeMatches, loadCandidates } from '../recipe/matches.js';

const CONTEXT_TYPE = 'ContextRecipe';
const ROOT = 'root';
const PINNED = 'pinned';

// What the descriptions call the members: a principal recipe holds users.
const nounOf = (recipe) => (recipe.target === 'principal' ? 'users' : 'objects');

function rootAttributes(recipe, kept) {
  const attrs = { builtWith: 'context-assistant', terms: kept, fields: recipe.fields, resourceTypes: recipe.resourceTypes };
  if (recipe.target === 'principal') Object.assign(attrs, { target: 'principal', assignmentTypes: recipe.access.assignmentTypes });
  return attrs;
}

function rootNode(recipe, memberCount) {
  const kept = recipe.terms.filter(t => t.state === 'accepted').map(t => t.text);
  const noun = nounOf(recipe);
  return {
    externalId: ROOT,
    displayName: recipe.name || 'Context',
    contextType: CONTEXT_TYPE,
    description: kept.length
      ? `${memberCount} ${noun} found by: ${kept.join(', ')}.`
      : `${memberCount} ${noun} added by hand.`,
    extendedAttributes: rootAttributes(recipe, kept),
  };
}

/**
 * Shape the plugin output for a validated recipe and its computed members.
 *
 * `result` is computeMatches() for a resource recipe, or computePrincipals() for a
 * principal recipe — both carry memberIds and termMembers; the members no kept term
 * finds are `pinnedIds` when given, else the matches included by hand.
 * @returns {import('./types.js').PluginRunResult}
 */
export function buildTree(recipe, result) {
  const noun = nounOf(recipe);
  const contexts = [rootNode(recipe, result.memberIds.length)];
  const members = [];
  if (recipe.structure === 'flat') {
    for (const id of result.memberIds) members.push({ contextExternalId: ROOT, memberId: id });
    return { contexts, members };
  }

  // In the order of the terms, not the order they first found something.
  const byTerm = [...result.termMembers].sort((a, b) => a[0] - b[0]);
  for (const [termIndex, ids] of byTerm) {
    const term = recipe.terms[termIndex];
    const externalId = `term:${term.key}`;
    contexts.push({
      externalId,
      parentExternalId: ROOT,
      displayName: term.text,
      contextType: CONTEXT_TYPE,
      description: `${ids.length} ${noun} found by "${term.text}".`,
      extendedAttributes: { term: term.text, match: term.match },
    });
    for (const id of ids) members.push({ contextExternalId: externalId, memberId: id });
  }

  const pinnedOnly = result.pinnedIds ?? result.matches.filter(m => m.status === 'included').map(m => m.id);
  if (pinnedOnly.length) {
    contexts.push({
      externalId: PINNED,
      parentExternalId: ROOT,
      displayName: 'Added by hand',
      contextType: CONTEXT_TYPE,
      description: `${pinnedOnly.length} ${noun} included by hand.`,
    });
    for (const id of pinnedOnly) members.push({ contextExternalId: PINNED, memberId: id });
  }
  return { contexts, members };
}

/**
 * The validated recipe of a run, for the plugin of its target. A recipe that cannot run,
 * or was saved for the other plugin, fails the run rather than building a wrong tree.
 */
export function recipeFor(params, target) {
  const { ok, recipe, errors } = validateRecipe(params.recipe);
  if (!ok) throw new Error(`The context recipe cannot be used: ${errors.join(' ')}`);
  if (recipe.target !== target) throw new Error(`This recipe collects ${recipe.target}s; it belongs to the other context-recipe plugin.`);
  return recipe;
}

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: 'context-recipe',
  displayName: 'Context assistant recipe',
  description: 'Builds a context from search terms and hand-picked objects chosen in the context assistant. Refreshed after every crawl.',
  targetType: 'Resource',
  hidden: true,
  parametersSchema: {
    type: 'object',
    properties: {
      recipe: { type: 'object', description: 'The recipe built in the context assistant.' },
    },
    required: ['recipe'],
  },

  async run(params, ctx = {}) {
    const recipe = recipeFor(params, 'resource');
    const { rows, scopeTotal, truncated } = await loadCandidates(recipe, ctx.tx || tx);
    if (truncated) ctx.log?.(`More than ${rows.length} objects matched; the rest were left out.`);
    return buildTree(recipe, computeMatches(rows, recipe, scopeTotal));
  },
};
