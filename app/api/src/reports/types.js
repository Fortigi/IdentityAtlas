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
 * @property {ReportNotice[]} [notices]  Context for those rows. Whether a
 *                            download carries them is the FORMAT's decision,
 *                            declared as `carriesContext` in export.js: a
 *                            workbook writes them above the table, a CSV cannot
 *                            (a preamble above the header breaks every parser
 *                            that reads it). So a report whose rows need the
 *                            caveat to be readable *as a CSV* must still carry
 *                            it as a column.
 * @property {string[]} [constantColumns]  Column keys that hold ONE value for
 *                            the whole of THIS run — not for the report in
 *                            general. A format with room for a header shows
 *                            them once, above the table, and leaves them out of
 *                            it; a format without one keeps them on every row.
 *                            Declared by the run, never derived from the rows:
 *                            a column can happen to hold one distinct value
 *                            (every entitlement in an application being
 *                            non-requestable, say) without that being a fact
 *                            about the run, and deriving it would silently
 *                            delete a real column. `columns` itself does not
 *                            change — the screen shows all of them.
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
 * @property {ReportPivot[]} [pivots]   Pivot tables the xlsx download opens with.
 * @property {Function} run             (params, ctx) => Promise<ReportRunResult>
 */

/**
 * @typedef {Object} ReportPivot
 *   One pivot table, on its own tab of the xlsx download, over the report's
 *   rows. Every field is a column key; values are summed.
 * @property {string}   name       Tab name.
 * @property {string[]} [rows]     Row fields, outermost first.
 * @property {string[]} [filters]  Filter (page) fields.
 * @property {string[]} [values]   Fields summed in the value area.
 */

export {};
