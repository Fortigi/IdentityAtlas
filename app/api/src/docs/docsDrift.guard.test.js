// Docs-drift guard — retired vocabulary and broken links/anchors in docs/,
// measured against the committed baselines in .ci/.
//
// Runs in `Unit Tests: Vitest (API)`, which a docs-only PR triggers too. A
// finding that is NEW fails; a page that improved never does. To see the same
// result by hand, or lower a baseline: `cd app/api && npm run docs:check` /
// `npm run docs:baseline` (see docs/contributing/ci-pipeline.md).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, listPages } from './docsStructure.js';
import { EXEMPT, TERMS, countTerms, docsJargon } from './docsJargon.js';
import { docsLinks } from './docsLinks.js';
import { RATCHETS, baselineDir, checkRatchet, failureMessage, readBaseline } from './cli.js';

describe.each(RATCHETS)('docs $name', ratchet => {
  it('has not got worse than its baseline', () => {
    const { regressions } = checkRatchet(ratchet);
    expect(
      regressions,
      `${failureMessage(ratchet, regressions)}\n` +
        `Fix the page. The baseline (.ci/${ratchet.file}) only ever shrinks.`,
    ).toEqual([]);
  });

  it('keeps a baseline of positive whole counts', () => {
    // Deliberately NOT checked: that every listed page still exists. A PR that
    // deletes or moves a grandfathered page must not have to touch this file.
    const baseline = readBaseline(join(baselineDir(), ratchet.file));
    const bad = Object.entries(baseline).flatMap(([page, items]) =>
      Object.entries(items).filter(([, n]) => !Number.isInteger(n) || n < 1).map(([item]) => `${page}: ${item}`));
    expect(bad).toEqual([]);
  });
});

describe('the measurements see the real tree', () => {
  // An empty measurement satisfies "not worse than the baseline" vacuously —
  // exactly what a broken walk or a pattern that never matches would produce.
  it('finds retired words in real page text, and honours the exemption for that page', () => {
    // The CI Pipeline page names SOLL and IST in order to describe this guard,
    // so the counter demonstrably works on a real file…
    const text = readFileSync(join(REPO_ROOT, 'docs', 'contributing', 'ci-pipeline.md'), 'utf8');
    expect(countTerms(text).SOLL).toBeGreaterThanOrEqual(1);
    expect(countTerms(text).IST).toBeGreaterThanOrEqual(1);
    // …and the exemption is the only reason the page is not in the measurement.
    const measured = docsJargon();
    expect(measured).not.toHaveProperty('contributing/ci-pipeline.md');
    for (const page of Object.keys(measured)) expect(listPages()).toContain(page);
  });

  it('measures links as page → target → count', () => {
    for (const [page, targets] of Object.entries(docsLinks())) {
      expect(listPages()).toContain(page);
      for (const n of Object.values(targets)) expect(n).toBeGreaterThan(0);
    }
  });

  it('exempts nothing that the baseline also lists', () => {
    // A page cannot be both "allowed to keep the old words" and "owes a fix".
    const baseline = readBaseline(join(baselineDir(), RATCHETS[0].file));
    const both = Object.keys(baseline).filter(page => EXEMPT[page] === true);
    expect(both).toEqual([]);
  });
});

describe('one vocabulary for the UI and the docs', () => {
  it('bans in docs every term the UI lint rule bans', () => {
    // The UI rule is another package's file, so the list is repeated rather
    // than imported; this keeps the two from drifting apart.
    const rule = readFileSync(join(REPO_ROOT, 'app', 'ui', 'eslint-rules', 'no-legacy-jargon.js'), 'utf8');
    const uiTerms = [...rule.matchAll(/term: '([^']+)'/g)].map(m => m[1]);
    expect(uiTerms).toEqual(expect.arrayContaining(['SOLL', 'IST', 'Org Unit', 'Start-FGSync']));
    const docsTerms = TERMS.map(t => t.term);
    for (const term of uiTerms) expect(docsTerms, `docsJargon.js must also ban "${term}"`).toContain(term);
  });
});
