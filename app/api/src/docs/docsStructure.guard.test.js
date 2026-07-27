// Docs-structure guard — the CI half of the documentation learning path.
//
// The docs site is only built on push to main (.github/workflows/docs.yml), so
// nothing on a PR ever notices a page that fell out of the nav or a cross-link
// that stopped resolving. These assertions run in the normal Vitest job and in
// the dedicated `docs-structure` PR check, so a docs-only PR is gated too.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DOCS_ROOT,
  brokenLinks,
  contractViolations,
  danglingNavEntries,
  learningPathPages,
  listPages,
  navEntries,
  orphanPages,
  prereqCycles,
} from './docsStructure.js';

const list = rows => '\n  - ' + rows.join('\n  - ');

describe('documentation structure', () => {
  it('has pages', () => {
    expect(listPages().length).toBeGreaterThan(50);
  });

  it('reaches every page from the site navigation', () => {
    const orphans = orphanPages();
    expect(
      orphans,
      `These pages exist but are unreachable from the nav — a reader can only find them by\n` +
        `search. Add them to mkdocs.yml under the section they belong to:${list(orphans)}`
    ).toEqual([]);
  });

  it('has no navigation entry pointing at a missing page', () => {
    const dangling = danglingNavEntries().map(e => `${e.page} (nav: "${e.title}")`);
    expect(
      dangling,
      `mkdocs.yml lists pages that do not exist — the site build will fail:${list(dangling)}`
    ).toEqual([]);
  });

  it('resolves every relative link between documentation pages', () => {
    const broken = brokenLinks().map(b => `${b.page} → ${b.target}`);
    expect(
      broken,
      `Broken cross-links between docs pages:${list(broken)}`
    ).toEqual([]);
  });
});

// The requestor's explicit reject criteria for the restructure: "I would not be
// happy if the documentation becomes light weight, that I can't find the actual
// details anymore... if it becomes hard to get an overview of the data model or
// the core concepts... it becomes a marketing site."
//
// Encoded here so dilution fails CI instead of being noticed six months later.
describe('technical depth is preserved', () => {
  // The pages an advanced reader comes for. Losing any of them from the tree,
  // or from the menu, is the failure mode this restructure must not cause.
  const DEPTH_ANCHORS = [
    'concepts/data-model.md',
    'concepts/governance-model.md',
    'concepts/risk-scoring-model.md',
    'architecture/effective-access-engine.md',
    'architecture/crawler-architecture.md',
    'architecture/ingest-api.md',
    'architecture/csv-import-schema.md',
    'architecture/audit-history.md',
    'architecture/soft-delete.md',
    'risk-scoring/design.md',
    'risk-scoring/plugin-architecture.md',
    'reference/sql-views.md',
    'reference/config.md',
    'reference/permissions.md',
    'api/index.md',
  ];

  it.each(DEPTH_ANCHORS)('keeps %s in the tree and in the menu', page => {
    expect(listPages(), 'page must still exist').toContain(page);
    expect(navEntries().map(e => e.page), 'page must still be in the nav').toContain(page);
  });

  it('has not shed pages', () => {
    // 97 at the restructure. Pages may be added; a drop means something was
    // deleted rather than re-homed, which the pinned scope forbids.
    expect(listPages().length).toBeGreaterThanOrEqual(97);
  });

  it('puts the deep technical pages one click from the top, not buried in Project', () => {
    const byPage = new Map(navEntries().map(e => [e.page, e.tab]));
    for (const page of ['architecture/effective-access-engine.md', 'architecture/crawler-architecture.md', 'risk-scoring/design.md']) {
      expect(byPage.get(page), `${page} should live under Reference`).toBe('Reference');
    }
  });

  it('reaches the data model and core concepts directly from the home page', () => {
    const home = readFileSync(join(DOCS_ROOT, 'index.md'), 'utf8');
    for (const page of ['concepts/data-model.md', 'reference/config.md']) {
      expect(home, `home page should link ${page}`).toContain(page);
    }
  });
});

describe('learning path contract', () => {
  it('covers the reader-ordered tabs', () => {
    expect(learningPathPages().length).toBeGreaterThanOrEqual(20);
  });

  it('declares type, prereq and outcome on every learning-path page', () => {
    const problems = contractViolations().map(p => `${p.page}: ${p.problem}`);
    expect(
      problems,
      `Pages on the Start here / Learn / Use path must declare their place in the path\n` +
        `in front matter (type, prereq, outcome):${list(problems)}`
    ).toEqual([]);
  });

  it('has at least one entry point that assumes nothing', () => {
    const entries = learningPathPages().filter(p => {
      const e = navEntries().find(n => n.page === p);
      return e && e.tab === 'Start here';
    });
    expect(entries.length).toBeGreaterThan(0);
  });

  it('orders prerequisites without a cycle', () => {
    const cycles = prereqCycles().map(c => c.join(' → '));
    expect(
      cycles,
      `A prerequisite chain loops, so there is no way into it:${list(cycles)}`
    ).toEqual([]);
  });
});
