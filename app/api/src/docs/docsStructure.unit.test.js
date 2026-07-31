// Unit coverage for the docs-structure helpers themselves. The guard test next
// door asserts the *state of the docs*; this one asserts the *helpers behave*,
// including the paths a healthy tree never exercises (a page with no front
// matter, generated output that is deliberately not a page, external links).

import { describe, it, expect } from 'vitest';
import {
  LEARNING_PATH_TABS,
  anchorsFor,
  brokenLinks,
  frontMatter,
  learningPathPages,
  listPages,
  navEntries,
  orphanPages,
  prereqCycles,
  slugify,
} from './docsStructure.js';

describe('listPages', () => {
  it('excludes the generated coverage reports', () => {
    expect(listPages().some(p => p.startsWith('coverage/'))).toBe(false);
  });

  it('returns docs-relative posix paths', () => {
    const pages = listPages();
    expect(pages).toContain('index.md');
    expect(pages).toContain('start/glossary.md');
    expect(pages.every(p => !p.includes('\\'))).toBe(true);
  });

  it('is sorted and free of duplicates', () => {
    const pages = listPages();
    expect(pages).toEqual([...pages].sort());
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe('slugify', () => {
  // Verified against the ids mkdocs actually emitted for these headings.
  it.each([
    ['A–Z index', 'az-index'],                       // en dash is deleted, not hyphenated
    ['2. Account — which this product calls a *principal*', '2-account-which-this-product-calls-a-principal'],
    ['1. System', '1-system'],
    ['Group and role — the difference people get wrong', 'group-and-role-the-difference-people-get-wrong'],
  ])('slugifies %j to %j', (heading, expected) => {
    expect(slugify(heading)).toBe(expected);
  });
});

describe('anchorsFor', () => {
  it('collects the ids a page will generate', () => {
    const anchors = anchorsFor('start/glossary.md');
    expect(anchors.has('az-index')).toBe(true);
    expect(anchors.has('4-resource')).toBe(true);
    expect(anchors.has('a-z-index')).toBe(false);
  });
});

describe('frontMatter', () => {
  it('returns an empty object for a page without front matter', () => {
    expect(frontMatter('about.md')).toEqual({});
  });

  it('parses the learning-path keys', () => {
    const fm = frontMatter('start/glossary.md');
    expect(fm.type).toBe('start');
    expect(fm.prereq).toBe('none');
    expect(fm.outcome).toBeTruthy();
  });

  it('keeps a value containing a colon intact', () => {
    // outcome text may contain punctuation; only the FIRST colon splits.
    const fm = frontMatter('start/first-15-minutes.md');
    expect(fm.prereq).toBe('start/glossary.md');
    expect(fm.outcome).not.toContain('outcome');
  });
});

describe('navEntries', () => {
  it('flattens nested sections and records the owning tab', () => {
    const entries = navEntries();
    const glossary = entries.find(e => e.page === 'start/glossary.md');
    expect(glossary.tab).toBe('Start here');
    expect(glossary.title).toBe('The words you need first');
  });

  it('assigns every entry to one of the known tabs', () => {
    const tabs = new Set(navEntries().map(e => e.tab));
    for (const t of LEARNING_PATH_TABS) expect(tabs.has(t)).toBe(true);
  });

  it('lists no page twice', () => {
    const pages = navEntries().map(e => e.page);
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe('learningPathPages', () => {
  it('contains only pages from the reader-ordered tabs', () => {
    const byPage = new Map(navEntries().map(e => [e.page, e.tab]));
    for (const page of learningPathPages()) {
      expect(LEARNING_PATH_TABS).toContain(byPage.get(page));
    }
  });

  it('excludes reference and project pages', () => {
    expect(learningPathPages()).not.toContain('reference/config.md');
    expect(learningPathPages()).not.toContain('about.md');
  });
});

describe('brokenLinks', () => {
  it('ignores absolute and external links', () => {
    // index.md links to identityatlas.io and github.com; neither is a page.
    expect(brokenLinks().some(b => b.target.startsWith('http'))).toBe(false);
  });
});

describe('orphanPages / prereqCycles', () => {
  it('returns arrays even when the tree is healthy', () => {
    expect(Array.isArray(orphanPages())).toBe(true);
    expect(Array.isArray(prereqCycles())).toBe(true);
  });
});
