// Detect the newest available version for a channel — read-only, no Docker and
// no registry token, so it works identically on Docker, Azure, and local installs
// (anything with outbound HTTPS to GitHub).
//
//   latest → newest published GitHub release (non-prerelease)
//   beta   → newest GitHub pre-release
//   edge   → the ModuleVersion on `main` (edge images are built per main merge,
//            and bump-version.yml writes that version into the .psd1), read from
//            raw.githubusercontent.com
//
// `fetchImpl` is injectable so unit tests don't hit the network.

import { compareVersions } from './versionCompare.js';

const REPO = 'Fortigi/IdentityAtlas';
const GH_API = 'https://api.github.com';
const GH_RAW = 'https://raw.githubusercontent.com';

function ghHeaders() {
  const h = { 'User-Agent': 'IdentityAtlas-updater', Accept: 'application/vnd.github+json' };
  // Optional — lifts the 60/hr anonymous rate limit if an operator sets it.
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// Normalise a git tag to the image version format:
//   'v5.2.1'        → '5.2.1.0'  (release tags are Major.Minor.Patch; images add .0)
//   'v5.3.0-beta.2' → '5.3.0-beta.2'
export function normalizeTag(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  let t = tag.replace(/^v/i, '');
  if (/^\d+\.\d+\.\d+$/.test(t)) t = `${t}.0`;
  return t;
}

async function latestEdge(fetchImpl) {
  const headers = { 'User-Agent': 'IdentityAtlas-updater' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetchImpl(`${GH_RAW}/${REPO}/main/setup/IdentityAtlas.psd1`, { headers });
  if (!r.ok) throw new Error(`psd1 fetch returned ${r.status}`);
  const text = await r.text();
  const m = text.match(/ModuleVersion\s*=\s*'([^']+)'/);
  if (!m) throw new Error('ModuleVersion not found in manifest');
  return m[1];
}

async function latestRelease(fetchImpl) {
  const r = await fetchImpl(`${GH_API}/repos/${REPO}/releases/latest`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`releases/latest returned ${r.status}`);
  const j = await r.json();
  return normalizeTag(j?.tag_name);
}

async function latestBeta(fetchImpl) {
  const r = await fetchImpl(`${GH_API}/repos/${REPO}/releases?per_page=30`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`releases returned ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) return null;
  const pre = list
    .filter((x) => x && x.prerelease && !x.draft && x.tag_name)
    .map((x) => normalizeTag(x.tag_name))
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
  return pre[0] || null;
}

// Returns the newest version string for the channel, or null when there's
// nothing to compare against (e.g. a pinned deployment).
export async function getLatestForChannel(channel, fetchImpl = fetch) {
  switch (channel) {
    case 'edge':
      return latestEdge(fetchImpl);
    case 'beta':
      return latestBeta(fetchImpl);
    case 'latest':
      return latestRelease(fetchImpl);
    default:
      return null;
  }
}
