// Links and anchors across the WHOLE docs tree.
//
// docsStructure.js already fails a PR on a link to a page that does not exist,
// and on a dead #anchor between learning-path pages. What it leaves open is
// what mkdocs itself only reports as INFO, so the site builds green with links
// that go nowhere:
//
//   - a #anchor on or into any page outside the learning path
//     (`reference/config.md#smtp--mail` when the heading generates `#smtp-mail`);
//   - a link or image whose target is not a page: a missing screenshot, a file
//     outside docs/ that the site does not publish.
//
// Older pages carry some of these, so this check is a ratchet (docsRatchet.js)
// with a baseline in .ci/docs-links-baseline.json, not a hard zero.

import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import {
  DOCS_ROOT, EXTERNAL_RE, LINK_RE, headingAnchors, listPages, prose,
} from './docsStructure.js';

// Ids the site generates by itself (footnotes, content tabs, line anchors) —
// nothing in the page source declares them, so they cannot be checked here.
const GENERATED_ANCHOR_RE = /^(fn:|fnref:|__)/;

/** Link targets a reader can click: prose only, inline code spans removed. */
export function linkTargets(body) {
  const text = prose(body).replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(LINK_RE)].map(m => m[1]);
}

/**
 * Why one link target is broken, or null when it is fine or not ours to check.
 *
 * `site` describes the docs tree: `pages` (a Set of docs-relative page paths),
 * `exists(path)` for any other file under docs/, and `anchors(page)` for the
 * ids a page generates.
 */
export function linkProblem(fromPage, raw, site) {
  if (EXTERNAL_RE.test(raw) || raw.startsWith('/')) return null;
  const hash = raw.indexOf('#');
  const target = hash < 0 ? raw : raw.slice(0, hash);
  const anchor = hash < 0 ? '' : raw.slice(hash + 1);
  const resolved = target
    ? posix.normalize(posix.join(posix.dirname(fromPage), target))
    : fromPage;

  if (resolved.startsWith('../')) return 'points outside docs/, which the site does not publish';
  if (!site.pages.has(resolved)) {
    // A missing PAGE is the hard `brokenLinks` gate's finding, not this one's.
    if (resolved.endsWith('.md') || site.exists(resolved)) return null;
    return 'no such file';
  }
  if (!anchor || GENERATED_ANCHOR_RE.test(anchor)) return null;
  return site.anchors(resolved).has(anchor) ? null : `no heading generates #${anchor}`;
}

/**
 * Measure broken links over a set of pages: { page: { rawTarget: count } }.
 * `read` maps a page to its text.
 */
export function measureLinks(pages, read, exists) {
  const cache = new Map();
  const site = {
    pages: new Set(pages),
    exists,
    anchors(page) {
      if (!cache.has(page)) cache.set(page, headingAnchors(read(page)));
      return cache.get(page);
    },
  };
  const out = {};
  for (const page of pages) {
    for (const raw of linkTargets(read(page))) {
      if (!linkProblem(page, raw, site)) continue;
      const counts = (out[page] ??= {});
      counts[raw] = (counts[raw] ?? 0) + 1;
    }
  }
  return out;
}

/** The measurement for the real docs tree. */
export function docsLinks() {
  return measureLinks(
    listPages(),
    page => readFileSync(join(DOCS_ROOT, page), 'utf8'),
    path => existsSync(join(DOCS_ROOT, path)),
  );
}
