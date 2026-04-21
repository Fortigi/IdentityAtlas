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
 * @property {string} contextType        Free-form sub-classification.
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
 * @property {string} description
 * @property {('Identity'|'Resource'|'Principal'|'System')} targetType
 * @property {Object} parametersSchema    JSON-Schema-ish (required + properties).
 * @property {Function} run               (params, ctx) => Promise<PluginRunResult>
 */

export {};
