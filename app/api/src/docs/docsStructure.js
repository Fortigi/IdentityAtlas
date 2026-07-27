// Structural model of the documentation site, derived from mkdocs.yml + docs/.
//
// This exists because the docs re-rot structurally, not just factually: pages
// get written and never added to the nav (15 were orphaned before the learning-
// path restructure), design proposals drift into the user-facing tree, and
// cross-links break silently because nothing on a PR ever builds the site
// (.github/workflows/docs.yml only runs on push to main).
//
// The guard test next to this file turns each function below into a CI check.
// Keep the functions pure and small — they are the ratcheted units.

import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, posix } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yamljs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../../..');
export const DOCS_ROOT = join(REPO_ROOT, 'docs');
export const MKDOCS = join(REPO_ROOT, 'mkdocs.yml');

// Generated HTML coverage reports — committed by coverage.yml, linked from the
// curated Test Coverage page, deliberately not in the nav (see `not_in_nav`).
const NOT_A_PAGE = ['coverage/'];

// Tabs whose pages carry the learning-path contract. Reference/Project pages are
// looked up, not read in order, so they are deliberately exempt.
export const LEARNING_PATH_TABS = ['Start here', 'Learn', 'Use'];

export const PAGE_TYPES = ['start', 'concept', 'task'];

/** Every markdown page that exists on disk, as docs-relative posix paths. */
export function listPages(dir = DOCS_ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { out.push(...listPages(abs)); continue; }
    if (!name.endsWith('.md')) continue;
    const rel = relative(DOCS_ROOT, abs).split('\\').join('/');
    if (NOT_A_PAGE.some(prefix => rel.startsWith(prefix))) continue;
    out.push(rel);
  }
  return out.sort();
}

/** The mkdocs nav, flattened to [{ tab, title, page }] in document order. */
export function navEntries() {
  const nav = YAML.parse(readFileSync(MKDOCS, 'utf8')).nav || [];
  const out = [];
  for (const top of nav) {
    const [tab, value] = Object.entries(top)[0];
    walkNav(value, tab, out);
  }
  return out;
}

function walkNav(value, tab, out, title = tab) {
  if (typeof value === 'string') { out.push({ tab, title, page: value }); return; }
  if (!Array.isArray(value)) return;
  for (const child of value) {
    const [childTitle, childValue] = Object.entries(child)[0];
    walkNav(childValue, tab, out, childTitle);
  }
}

/** Pages that exist on disk but are unreachable from the nav. */
export function orphanPages() {
  const inNav = new Set(navEntries().map(e => e.page));
  return listPages().filter(page => !inNav.has(page));
}

/** Nav entries that point at a file that does not exist. */
export function danglingNavEntries() {
  const onDisk = new Set(listPages());
  return navEntries().filter(e => !onDisk.has(e.page));
}

// Deliberately captures the whole link target in one linear character class and
// splits off the #anchor in code — a single alternation-free pass, so there is
// no backtracking for a hostile page to exploit (eslint security/detect-unsafe-regex).
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Relative markdown links inside docs/ that do not resolve to a real page. */
export function brokenLinks() {
  const onDisk = new Set(listPages());
  const broken = [];
  for (const page of listPages()) {
    const body = readFileSync(join(DOCS_ROOT, page), 'utf8');
    for (const [, raw] of body.matchAll(LINK_RE)) {
      const target = raw.split('#')[0];
      if (!target.endsWith('.md')) continue;
      if (EXTERNAL_RE.test(target) || target.startsWith('/')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(page), target));
      if (!onDisk.has(resolved)) broken.push({ page, target, resolved });
    }
  }
  return broken;
}

/** Front matter of a page as a plain object (empty when the page has none). */
export function frontMatter(page) {
  const body = readFileSync(join(DOCS_ROOT, page), 'utf8');
  if (!body.startsWith('---\n')) return {};
  const end = body.indexOf('\n---', 4);
  if (end < 0) return {};
  const out = {};
  for (const line of body.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** Pages carrying the learning-path contract (the reader-ordered tabs). */
export function learningPathPages() {
  return navEntries()
    .filter(e => LEARNING_PATH_TABS.includes(e.tab))
    .map(e => e.page);
}

/**
 * Contract violations on the learning path: a missing/unknown `type`, a missing
 * `outcome`, or a `prereq` that is neither `none` nor an existing page.
 */
export function contractViolations() {
  const onDisk = new Set(listPages());
  const problems = [];
  for (const page of learningPathPages()) {
    const fm = frontMatter(page);
    if (!PAGE_TYPES.includes(fm.type)) problems.push({ page, problem: `type must be one of ${PAGE_TYPES.join('/')}, got ${JSON.stringify(fm.type)}` });
    if (!fm.outcome) problems.push({ page, problem: 'outcome is missing — say what the reader can do after this page' });
    if (!fm.prereq) problems.push({ page, problem: 'prereq is missing — use "none" if the page assumes nothing' });
    else if (fm.prereq !== 'none' && !onDisk.has(fm.prereq)) problems.push({ page, problem: `prereq "${fm.prereq}" does not exist` });
  }
  return problems;
}

/**
 * Prerequisite chains that loop. A cycle means the "easy → hard" ordering is a
 * lie: no reader can enter the path at any point in the loop.
 */
export function prereqCycles() {
  const prereqOf = new Map();
  for (const page of learningPathPages()) {
    const { prereq } = frontMatter(page);
    if (prereq && prereq !== 'none') prereqOf.set(page, prereq);
  }
  // Report each distinct loop once, however many chains happen to feed into it.
  const cycles = new Map();
  for (const start of prereqOf.keys()) {
    const seen = [start];
    let node = prereqOf.get(start);
    while (node && !seen.includes(node)) { seen.push(node); node = prereqOf.get(node); }
    if (!node) continue;
    const loop = seen.slice(seen.indexOf(node));
    cycles.set([...loop].sort().join('|'), [...loop, node]);
  }
  return [...cycles.values()];
}
