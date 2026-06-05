// Build a docs-site URL that points at the version matching the running build.
//
// The docs site is versioned with mike: every push to main publishes the
// `edge` alias; cutting a release publishes the version + the `stable` alias
// (which is the site default). So an *edge* build must link to `/edge/...`,
// otherwise the in-app "Documentation" link sends edge users to the last
// released (stable) docs — which won't match the running features.
//
// Channel is derived from the version string (same edge rule as the footer's
// "edge" badge in App.jsx):
//   edge/dev build → Major.Minor.yyyyMMdd.HHmm  (3rd segment is an 8-digit date)
//   anything else (release Major.Minor.Patch.0, or unknown) → stable (the
//   site default — safer than sending users to edge when unsure)
const DOCS_BASE = 'https://fortigi.github.io/IdentityAtlas';

export function docsVersionAlias(version) {
  const parts = (version || '').split('.');
  const isEdge = parts.length === 4 && /^\d{8}$/.test(parts[2]);
  return isEdge ? 'edge' : 'stable';
}

// `path` is appended after the version segment, e.g. docsUrl(v, '/concepts/data-model/').
export function docsUrl(version, path = '') {
  return `${DOCS_BASE}/${docsVersionAlias(version)}${path}`;
}
