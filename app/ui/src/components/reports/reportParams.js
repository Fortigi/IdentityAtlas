// Report parameters as a query string.
//
// A report's inputs travel in the URL, because that is already how the API
// passes them to a template (`run(params)` is the parsed query). Keeping the
// same encoding for the rows fetch and the download is what guarantees a
// downloaded file was produced with the settings on screen — not the defaults.

/**
 * The values a form should show: the schema's declared defaults, overridden by
 * whatever the user has actually set. Lets the form display the real thresholds
 * a report ran with before the user touches anything, without pre-populating
 * the query string.
 */
export function withSchemaDefaults(schema, params) {
  const props = schema?.properties || {};
  const defaults = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop?.default !== undefined) defaults[key] = prop.default;
  }
  return { ...defaults, ...params };
}

/**
 * `?a=1&b=2`, or '' when there is nothing to send. Empty and unset values are
 * dropped rather than sent blank, so clearing a field means "use the default"
 * — the same thing the templates do with an unparseable value.
 */
export function paramsQueryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}
