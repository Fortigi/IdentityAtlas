import { describe, expect, it } from 'vitest';
import { isAuditablePath, validateReport } from './findings.js';

const finding = over => ({
  fingerprint: 'docs:concepts/governance-model.md:catalog-table',
  kind: 'Wrong',
  docPath: 'docs/concepts/governance-model.md',
  title: 'Governance model still lists the GovernanceCatalogs table',
  docSays: 'Catalogs are stored in GovernanceCatalogs.',
  codeDoes: 'Migration 117 drops the table; a catalog is a Catalog context.',
  evidence: 'app/api/src/db/migrations/117_catalogs_as_contexts.sql:29',
  suggestion: 'Describe catalogs as contexts of the Catalog template.',
  ...over,
});

const report = over => ({
  reviewId: '2026-12',
  commit: 'ea9e117bc3',
  checked: ['docs/concepts/', 'ontology/core.ttl'],
  findings: [finding()],
  ...over,
});

describe('isAuditablePath', () => {
  it.each([
    'docs/concepts/governance-model.md',
    'ontology/core.ttl',
    'README.md',
    'CLAUDE.md',
    'app/api/CLAUDE.md',
  ])('accepts the hand-written page %s', p => expect(isAuditablePath(p)).toBe(true));

  it.each([
    ['generated coverage page', 'docs/coverage/api.md'],
    ['parent traversal', 'docs/../app/api/src/index.md'],
    ['source file', 'app/api/src/index.js'],
    ['docs page that is not markdown', 'docs/assets/logo.png'],
    ['absolute path', '/docs/index.md'],
    ['README somewhere else', 'app/README.md'],
    ['path with a space', 'docs/a b.md'],
    ['ontology file that is not Turtle', 'ontology/validation.json'],
    ['not a string', 42],
  ])('refuses a %s', (_, p) => expect(isAuditablePath(p)).toBe(false));
});

describe('validateReport', () => {
  it('numbers the findings Wrong, Stale, Missing whatever order they came in', () => {
    const r = validateReport(report({
      findings: [
        finding({ fingerprint: 'docs:a:missing-one', kind: 'Missing' }),
        finding({ fingerprint: 'docs:a:stale-one', kind: 'Stale' }),
        finding({ fingerprint: 'docs:a:wrong-one', kind: 'Wrong' }),
      ],
    }));
    expect(r.ok).toBe(true);
    expect(r.report.findings.map(f => [f.id, f.kind])).toEqual([
      ['DA-2026-12-01', 'Wrong'],
      ['DA-2026-12-02', 'Stale'],
      ['DA-2026-12-03', 'Missing'],
    ]);
  });

  it('accepts a review with no findings when it says what it read', () => {
    expect(validateReport(report({ findings: [] })).ok).toBe(true);
  });

  it('rejects a review that names nothing it read, even with no findings', () => {
    expect(validateReport(report({ checked: [], findings: [] })).problems).toEqual(['checked must list what was reviewed']);
  });

  it('rejects a checked list that is not short strings', () => {
    expect(validateReport(report({ checked: ['x'.repeat(201)] })).problems).toEqual(['checked must be at most 500 short strings']);
  });

  it('reports every problem in a malformed finding at once', () => {
    const r = validateReport(report({ findings: [finding({ kind: 'Typo', docPath: 'docs/coverage/x.md', title: ' ', fingerprint: 'Bad FP' })] }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'findings[0]: title is required',
      'findings[0]: kind must be one of Wrong, Stale, Missing',
      expect.stringMatching(/^findings\[0\]: docPath must be a hand-written page/),
      'findings[0]: fingerprint must be 6-120 lowercase characters [a-z0-9._:/-]',
    ]);
  });

  it('rejects text over its limit, at one character past it', () => {
    expect(validateReport(report({ findings: [finding({ docSays: 'x'.repeat(2000) })] })).ok).toBe(true);
    expect(validateReport(report({ findings: [finding({ docSays: 'x'.repeat(2001) })] })).problems)
      .toEqual(['findings[0]: docSays is longer than 2000 characters']);
  });

  it('rejects a bad header, too many findings, and a finding that is not an object', () => {
    expect(validateReport(report({ reviewId: '2026-13', commit: 'HEAD' })).problems)
      .toEqual(['reviewId must look like 2026-12', 'commit must be a git commit hash']);
    expect(validateReport(report({ findings: Array.from({ length: 101 }, (_, i) => finding({ fingerprint: `docs:x:n${i}aaaa` })) })).problems)
      .toEqual(['more than 100 findings']);
    expect(validateReport(report({ findings: [null] })).problems).toEqual(['findings[0] is not an object']);
    expect(validateReport(report({ findings: 'none' })).problems).toEqual(['findings must be a list']);
    expect(validateReport(null).problems).toEqual(['report is not an object']);
  });

  it('rejects the same fingerprint twice, which would file one issue for two problems', () => {
    expect(validateReport(report({ findings: [finding(), finding({ title: 'Other' })] })).problems)
      .toEqual(['fingerprint docs:concepts/governance-model.md:catalog-table appears twice']);
  });
});
