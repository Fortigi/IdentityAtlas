// context-recipe-principals plugin — the context assistant's "users with access" tree.
//
// Twin of context-recipe.js for recipes with target 'principal': same recipe, same tree
// shape (buildTree), but the members are the USERS who have access to the matched
// resources or belong to matching organisation entities (contexts/recipe/principals.js),
// so the contexts have targetType Principal. A second plugin rather than a per-run target
// type, because the runner takes a plugin's targetType from its registration.
//
// Refreshed after every crawl like every generated tree, and after an organisation import
// (orgtruth/projection/refresh.js), since org entities and their links decide part of the
// membership.

import { tx } from '../../db/connection.js';
import { loadCandidates } from '../recipe/matches.js';
import { runPrincipalRecipe } from '../recipe/principals.js';
import { buildTree, recipeFor } from './context-recipe.js';

export const PLUGIN_NAME = 'context-recipe-principals';

/** @type {import('./types.js').ContextPlugin} */
export default {
  name: PLUGIN_NAME,
  displayName: 'Context assistant recipe (users)',
  description: 'Builds a context of the users who have access to the resources, or belong to the organisation entities, chosen in the context assistant. Refreshed after every crawl and organisation import.',
  targetType: 'Principal',
  hidden: true,
  parametersSchema: {
    type: 'object',
    properties: {
      recipe: { type: 'object', description: 'The recipe built in the context assistant (target principal).' },
    },
    required: ['recipe'],
  },

  async run(params, ctx = {}) {
    const recipe = recipeFor(params, 'principal');
    const db = ctx.tx || tx;
    const { rows, scopeTotal, truncated } = await loadCandidates(recipe, db);
    if (truncated) ctx.log?.(`More than ${rows.length} resources matched; the rest were left out.`);
    const { principals, orgTruncated } = await runPrincipalRecipe(recipe, rows, scopeTotal, db);
    if (orgTruncated) ctx.log?.('More organisation entities matched than can be used; the rest were left out.');
    return buildTree(recipe, principals);
  },
};
