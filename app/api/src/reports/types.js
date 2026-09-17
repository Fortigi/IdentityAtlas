// Report-template contract.
//
// A report template is a regular ES module default-exporting one object that
// conforms to ReportTemplate. Templates live in src/reports/templates/ and are
// listed in templates/index.js; the engine (registry, routes, UI renderers)
// never names one. Adding a report is a template file plus one line in that
// index — if a second report needs an engine change, the seam is wrong.
//
// The shape deliberately mirrors the context-plugin contract
// (contexts/plugins/types.js): name / displayName / description /
// parametersSchema / run(params, ctx). Where a plugin declares a `targetType`,
// a report declares its presentation `form` and its `columns`.

/**
 * @typedef {Object} ReportColumn
 * @property {string} key    Row property this column reads.
 * @property {string} label  Column heading shown in the UI.
 */

/**
 * @typedef {Object} ReportRowEntity
 *   Optional link target, so a row can be clicked through to an existing
 *   detail tab. `kind` is a detail-tab entity kind ('user', 'group', …).
 * @property {string} kind
 * @property {string} id
 */

/**
 * @typedef {Object} ReportNotice
 *   A short statement ABOUT the rows rather than one of them: what the numbers
 *   were computed from, and when they stop being trustworthy. Rendered above the
 *   table. Generic on purpose — any template may return notices, and the engine
 *   never reads their text.
 * @property {'info'|'warning'} severity
 * @property {string} text
 */

/**
 * @typedef {Object} ReportRunResult
 * @property {Object[]} rows  One object per row; keys match the column keys,
 *                            plus an optional `_entity` link target.
 * @property {ReportNotice[]} [notices]  Screen-only context for those rows.
 *                            Downloads stay rows-only, so a report whose rows
 *                            need the caveat to be readable must also carry it
 *                            as a column.
 */

/**
 * @typedef {Object} ReportContext
 * @property {Function} [log] Optional progress logger.
 */

/**
 * @typedef {Object} ReportTemplate
 * @property {string} name              Stable slug, unique in the registry.
 * @property {string} displayName
 * @property {string} description
 * @property {string} form              Presentation form ('list', …). Resolved
 *                                       by the UI's form-renderer map.
 * @property {Object} parametersSchema  JSON-Schema-ish (required + properties).
 * @property {ReportColumn[]} columns
 * @property {Function} run             (params, ctx) => Promise<ReportRunResult>
 */

export {};
