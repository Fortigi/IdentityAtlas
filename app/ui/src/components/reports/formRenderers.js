// Form-renderer registry: presentation form → the component that draws it.
//
// Keyed on the report's `form`, never on its name — a new report of an existing
// form costs nothing here, and a new form is one entry. Mirrors the API-side
// template registry: the engine stays report-agnostic on both ends.

import ListReportRenderer from './ListReportRenderer';

export const FORM_RENDERERS = { list: ListReportRenderer };

/** The renderer for a report form, or null when the form is unknown to this UI. */
export function resolveFormRenderer(form) {
  return Object.hasOwn(FORM_RENDERERS, form) ? FORM_RENDERERS[form] : null;
}
