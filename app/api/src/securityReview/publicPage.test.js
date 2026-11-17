import { describe, expect, it } from 'vitest';
import { validateReport } from './findings.js';
import { ROWS_MARKER, cell, historyRow, monthName, pageFileName, renderPublicPage, updateIndex } from './publicPage.js';
import { finding, report } from './__mocks__/sampleReport.js';

const valid = r => validateReport(r).report;

const mixed = valid(report([
  finding({ fingerprint: 'medium-one', severity: 'Medium', owasp: 'A01' }),
  finding({ fingerprint: 'low-one', severity: 'Low', owasp: 'A05' }),
  finding({ fingerprint: 'info-one', severity: 'Informational', owasp: 'A05' }),
]));

describe('helpers', () => {
  it('names the month and the page file', () => {
    expect(monthName('2026-01')).toBe('January 2026');
    expect(monthName('2026-12')).toBe('December 2026');
    expect(pageFileName('2026-12')).toBe('review-2026-12.md');
  });

  it('keeps a table cell on one line and inert', () => {
    expect(cell('a | b\nc\r\nd <script>')).toBe('a \\| b c d &lt;script>');
  });
});

describe('renderPublicPage', () => {
  const filings = {
    'medium-one': { issueUrl: 'https://github.com/o/r/issues/12' },
    'low-one': { issueUrl: 'https://example.test/elsewhere' },
  };
  const page = renderPublicPage(mixed, filings);

  it('withholds everything but severity and category for a Medium finding', () => {
    expect(page).toContain('| SR-2026-12-01 | Medium | A01 | Details withheld until fixed | [#12](https://github.com/o/r/issues/12) |');
    for (const leak of ['medium-one', 'Secret description', 'Evidence of']) expect(page).not.toContain(leak);
  });

  it('shows the public summary of Low and Informational findings, and never their write-up', () => {
    expect(page).toContain('| SR-2026-12-02 | Low | A05 | Public summary of low-one | [tracking](https://example.test/elsewhere) |');
    expect(page).toContain('| SR-2026-12-03 | Informational | A05 | Public summary of info-one | — |');
    expect(page).not.toContain('Secret description');
  });

  it('counts findings per severity and per OWASP category', () => {
    expect(page).toContain('| Medium | 1 |');
    expect(page).toContain('| High | 0 |');
    expect(page).toContain('| **Total** | **3** |');
    expect(page).toContain('| A05 Injection | 2 | Checked A05 |');
    expect(page).toContain('| A01 Broken Access Control | 1 | Checked A01 |');
    expect(page).toContain('| A10 Mishandling of Exceptional Conditions | 0 | Checked A10 |');
  });

  it('names the version, a short commit and links the programme page', () => {
    expect(page).toContain('# Monthly security review — December 2026');
    expect(page).toContain('`6.95.20261201.0300` (commit `abcdef123`)');
    expect(page).toContain('[Security testing programme](index.md)');
    expect(page.startsWith('---\ntype: reference\n---')).toBe(true);
  });

  it('says so when there are no findings, and works without filings', () => {
    const empty = renderPublicPage(valid(report([])));
    expect(empty).toContain('## Findings\n\nNo findings.');
    expect(renderPublicPage(mixed)).toContain('| SR-2026-12-01 | Medium | A01 | Details withheld until fixed | — |');
  });

  it('leaves the notes cell empty for a category the coverage does not describe', () => {
    const r = { ...mixed, coverage: mixed.coverage.filter(c => c.category !== 'A03') };
    expect(renderPublicPage(r)).toContain('| A03 Software Supply Chain Failures | 0 |  |');
  });
});

describe('historyRow', () => {
  it('summarises the counts and how many findings are tracked privately', () => {
    expect(historyRow(mixed)).toBe(
      '| December 2026 | Monthly automated review | 6.95.20261201.0300, `abcdef123` | 1 Medium, 1 Low, 1 Informational | 1 Medium or higher, tracked privately | [Review, December 2026](review-2026-12.md) |',
    );
  });

  it('says when nothing Medium or higher was found, and when nothing was found at all', () => {
    expect(historyRow(valid(report([finding()])))).toContain('| 1 Low | No Medium or higher findings |');
    expect(historyRow(valid(report([])))).toContain('| No findings | No Medium or higher findings |');
  });
});

describe('updateIndex', () => {
  const index = [
    '## Monthly reviews',
    '',
    ROWS_MARKER,
    '| Month | Type | Version | Findings | Result | Summary |',
    '|---|---|---|---|---|---|',
    '| November 2026 | Monthly automated review | v | f | r | [Review, November 2026](review-2026-11.md) |',
    '',
    'After the table.',
  ].join('\n');

  it('adds the new review as the first row of the table', () => {
    const lines = updateIndex(index, mixed).split('\n');
    expect(lines[5]).toContain('[Review, December 2026](review-2026-12.md)');
    expect(lines[6]).toContain('November 2026');
    expect(lines.at(-1)).toBe('After the table.');
  });

  it('replaces the row of a review that is published again instead of adding a second one', () => {
    const twice = updateIndex(updateIndex(index, mixed), valid(report([])));
    expect(twice.match(/review-2026-12\.md/g)).toHaveLength(1);
    expect(twice).toContain('| No findings |');
  });

  it('refuses an index without the marker, or with the marker not right above a table', () => {
    expect(() => updateIndex('# no marker', mixed)).toThrow('has no');
    expect(() => updateIndex(`${ROWS_MARKER}\n\n| a |`, mixed)).toThrow('must be followed by a table header and separator');
    expect(() => updateIndex(`${ROWS_MARKER}\n| a |\n| not a separator |`, mixed)).toThrow('must be followed');
    expect(() => updateIndex(`${ROWS_MARKER}\n| a |`, mixed)).toThrow('must be followed');
  });
});
