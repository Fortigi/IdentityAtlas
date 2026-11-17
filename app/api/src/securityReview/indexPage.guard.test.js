// Guard: the monthly security review's publish step (cli.js publish) adds its
// row to the table under the marker on docs/security/index.md. If an edit to
// that page moves or drops the marker, the review would only fail at the end of
// a five-hour run. This catches it in the PR that makes the edit.
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../lib/repoRoot.js';
import { validateReport } from './findings.js';
import { ROWS_MARKER, updateIndex } from './publicPage.js';
import { report } from './__mocks__/sampleReport.js';

describe('docs/security/index.md', () => {
  const index = readFileSync(join(repoRoot(), 'docs', 'security', 'index.md'), 'utf8');

  it('has exactly one monthly-review marker, right above a table', () => {
    expect(index.split(ROWS_MARKER)).toHaveLength(2);
    const updated = updateIndex(index, validateReport(report([])).report);
    expect(updated).toContain('[Review, December 2026](review-2026-12.md)');
  });
});
