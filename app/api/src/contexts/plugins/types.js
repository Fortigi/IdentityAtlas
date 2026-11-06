// Context-algorithm plugin contract.
//
// A plugin is a regular ES module exporting one default object that conforms
// to ContextPlugin (documented in JSDoc below). Plugins live in
// app/api/src/contexts/plugins/ and are registered in registry.js.
//
// Plugins are NOT user-uploaded — they're in-tree code modules. Adding a
// plugin = dropping a new file + updating registry.js. There is no plugin
// SDK in v6; we will consider a real SDK when a concrete third-party use
// case lands.

/**
 * @typedef {Object} ContextNode
 *   The shape a plugin's `run()` returns for each context it produces.
 *   externalId must be unique within the plugin's output.
 * @property {string} externalId         Stable id within this plugin run.
 * @property {string} displayName
 * @property {string} contextType        Sub-classification; one of the plugin's contextTypes.
 * @property {string} [contextCategory]   The template (OrganizationalUnit | LogicalApplication | Tag | Segment)
 *                                        when it differs per node (the recipe); else the plugin's.
 * @property {string} [description]
 * @property {string} [parentExternalId] Optional parent (must match another node's externalId in the same run).
 * @property {Object} [extendedAttributes]
 */

/**
 * @typedef {Object} ContextMemberLink
 * @property {string} contextExternalId
 * @property {string} memberId            UUID of the member entity.
 */

/**
 * @typedef {Object} PluginRunResult
 * @property {ContextNode[]} contexts
 * @property {ContextMemberLink[]} members
 * @property {ContextRoleLink[]} [roles]   Who answers for a context; only an OrganizationalUnit
 *                                          or LogicalApplication carries roles.
 */

/**
 * @typedef {Object} ContextRoleLink
 * @property {string} contextExternalId
 * @property {string} [principalId]        UUID of the account, or
 * @property {string} [identityId]         UUID of the person; exactly one.
 * @property {('Accountable'|'Responsible')} role
 */

/**
 * @typedef {Object} PluginContext
 * @property {Object} db                  The db module (connection.js).
 * @property {string} runId               ContextAlgorithmRuns.id.
 * @property {Function} log               Append a log line to the run's status.
 */

/**
 * @typedef {Object} ContextPlugin
 * @property {string} name                Matches ContextAlgorithms.name. Stable.
 * @property {string} displayName
 * @property {string} [rootDisplayName] The name of the root the runner adds when a run produces several
 *                                        roots (runner.helpers.js withPluginRoot); else displayName.
 * @property {string} description
 * @property {('Identity'|'Resource'|'Principal'|'System')} targetType
 * @property {string[]} contextTypes      Every contextType the plugin can emit. The core
 *                                        ontology (ontology/core.ttl) declares each one;
 *                                        npm run ontology:check compares the two.
 * @property {string} contextCategory    The template every node falls under (see contextCategory on
 *                                        ContextNode for a per-node override). One of CONTEXT_CATEGORIES.
 * @property {Object} parametersSchema    JSON-Schema-ish (required + properties).
 * @property {Function} run               (params, ctx) => Promise<PluginRunResult>
 */

export {};
