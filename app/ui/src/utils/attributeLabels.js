// Client-side lookup for extendedAttributes display names (issue #872).
//
// This holds NO rule. The rule that turns
// `extension_8ce8d3db3b314def88d829e15494e83f_sAMAccountName` into
// `sAMAccountName` lives once, server-side, in `app/api/src/lib/attributeLabels.js`
// — deliberately, because the Power Query workbook reads the same endpoint and a
// second implementation over here is exactly how the Excel header and the
// on-screen header would drift apart.
//
// What lives here is a session cache of that server answer, so every surface that
// renders an attribute NAME — the entity detail tables, the matrix grouping
// headers and roll-up captions, the sort / roll-up attribute picker, the
// context-plugin attribute picker and the matrix xlsx export — resolves the same
// string without each of them fetching, and without the map being prop-drilled
// through the matrix render tree.
//
// `attributeLabel` returns null when it has no answer, which lets each call site
// keep its own established fallback (a humanised label in the detail table, the
// raw key in the pickers) rather than having one imposed on it.

let labels = Object.create(null);
let inflight = null;
let loaded = false;

// Accepts either a raw storage key (`extension_<appId>_sfTeamID`) or the
// namespaced filter/sort key the matrix uses for the same thing
// (`ext.extension_<appId>_sfTeamID`).
export function attributeLabel(key) {
  if (key == null) return null;
  return labels[String(key).replace(/^ext\./, '')] || null;
}

// Seed the cache directly — used by the loader and by tests, which must be able
// to render a labelled surface without a network round-trip.
// Null-prototype: lookups are keyed by data-derived names, and `constructor` /
// `toString` are legal JSON keys — an inherited Object.prototype member must not
// read back as somebody's display name.
export function setAttributeLabels(map) {
  labels = Object.assign(Object.create(null), map && typeof map === 'object' ? map : {});
  loaded = true;
}

export function resetAttributeLabels() {
  labels = Object.create(null);
  inflight = null;
  loaded = false;
}

// Fetch once per session. A failure leaves the cache empty on purpose: every
// call site then falls back to what it rendered before this feature existed, so
// a 500 from the endpoint costs clean names, never a blank screen.
export function loadAttributeLabels(authFetch) {
  if (loaded) return Promise.resolve(labels);
  if (inflight) return inflight;
  inflight = authFetch('/api/attribute-labels')
    .then(r => (r.ok ? r.json() : { labels: {} }))
    .then(body => {
      setAttributeLabels(body && body.labels);
      return labels;
    })
    .catch(() => {
      setAttributeLabels({});
      return labels;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
