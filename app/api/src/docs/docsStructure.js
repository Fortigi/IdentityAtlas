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
import { join, relative, posix } from 'path';
import YAML from 'yaml';
import { repoRoot } from '../lib/repoRoot.js';

export const REPO_ROOT = repoRoot();
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
  const nav = YAML.parse(readFileSync(MKDOCS, 'utf8'), { logLevel: 'error' }).nav || [];
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
// Anything between the target and the closing parenthesis (a quoted title, as
// in `[a](b.md "Title")`) is skipped; only the target is captured.
export const LINK_RE = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
export const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A page's prose, with fenced code blocks blanked out.
 *
 * Markdown inside a fence is sample text, not a link — a design doc that quotes
 * the CLAUDE.md line it proposes shows a target written relative to the repo
 * root, which is nonsense relative to the page holding the fence. Scanning it
 * as a real link reported a broken cross-link no reader can click. Fenced lines
 * are blanked rather than dropped so line numbers still line up.
 */
export function prose(body) {
  let inFence = false;
  return body
    .split('\n')
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return ''; }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** Relative markdown links inside docs/ that do not resolve to a real page. */
export function brokenLinks() {
  const onDisk = new Set(listPages());
  const broken = [];
  for (const page of listPages()) {
    const body = prose(readFileSync(join(DOCS_ROOT, page), 'utf8'));
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

// Reproduces python-markdown's default `toc` slugify, which is what mkdocs uses
// to build heading ids: decompose accents and drop what is not ASCII; drop
// everything that is not a letter, digit, underscore, space or hyphen;
// lowercase; collapse runs of spaces/hyphens to ONE hyphen.
// Note what this does to punctuation authors do not think about — an en dash is
// simply deleted, so "A–Z index" becomes "az-index", not "a-z-index", and
// "Roles & groups" becomes "roles-groups", never "roles--groups".
// Markdown markers go first: `*` and backticks always, an underscore only where
// it is emphasis (at a word edge) — the one inside `ia_reader` is kept.
export function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '$1')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-');
}

const HEADING_RE = /^#{1,6}\s+(\S.*)$/;
// attr_list: `## Title { #custom-id }` (also `{: #custom-id }`) replaces the slug.
const HEADING_ATTR_RE = /\s*\{:?\s*([^}]*)\}\s*$/;
const CUSTOM_ID_RE = /(?:^|\s)#([\w:.-]+)/;
// Anchors that are not headings: raw HTML ids/names and attr_list ids on any block.
const HTML_ID_RE = /\b(?:id|name)="([^"]+)"/g;
const ATTR_ID_RE = /\{:?\s*#([\w:.-]+)[^}]*\}/g;

/**
 * Every anchor mkdocs will generate for a page body: one id per heading (a
 * repeated heading gets `_1`, `_2`, … like python-markdown does), custom
 * attr_list ids, and raw HTML ids. Headings inside code fences are not headings
 * — a `# comment` in a shell sample generates nothing.
 */
export function headingAnchors(body) {
  const text = prose(body);
  const ids = new Set();
  for (const line of text.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (!heading) continue;
    const attrs = HEADING_ATTR_RE.exec(heading[1]);
    const custom = attrs && CUSTOM_ID_RE.exec(attrs[1]);
    if (custom) { ids.add(custom[1]); continue; }
    const base = slugify(attrs ? heading[1].slice(0, attrs.index) : heading[1]);
    let id = base;
    for (let n = 1; ids.has(id); n += 1) id = `${base}_${n}`;
    ids.add(id);
  }
  for (const [, id] of text.matchAll(HTML_ID_RE)) ids.add(id);
  for (const [, id] of text.matchAll(ATTR_ID_RE)) ids.add(id);
  return ids;
}

/** Heading anchors mkdocs will generate for a page. */
export function anchorsFor(page) {
  return headingAnchors(readFileSync(join(DOCS_ROOT, page), 'utf8'));
}

/**
 * Links pointing at a #anchor that the target page will not generate. Scoped to
 * the learning path: mkdocs only reports these as INFO, so they never fail a
 * build, and the older pages carry a few that are not this change's to fix.
 */
export function brokenAnchors() {
  const inPath = new Set(learningPathPages());
  const broken = [];
  for (const page of inPath) {
    const body = prose(readFileSync(join(DOCS_ROOT, page), 'utf8'));
    for (const [, raw] of body.matchAll(LINK_RE)) {
      const link = anchorLinkTarget(page, raw, inPath);
      if (link && !anchorsFor(link.page).has(link.anchor)) broken.push({ page, target: raw });
    }
  }
  return broken;
}

/**
 * Resolve one markdown link to the {page, anchor} it points at, or null when it
 * is not an in-path anchor link we can check (no anchor, external, absolute, or
 * a page outside the learning path).
 */
function anchorLinkTarget(fromPage, raw, inPath) {
  const [target, anchor] = raw.split('#');
  if (!anchor) return null;
  if (EXTERNAL_RE.test(target) || target.startsWith('/')) return null;
  const page = target
    ? posix.normalize(posix.join(posix.dirname(fromPage), target))
    : fromPage;
  return inPath.has(page) ? { page, anchor } : null;
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
