import { describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { marker } from './filings.js';
import { ROWS_MARKER } from './publicPage.js';
import { finding, report } from './__mocks__/sampleReport.js';

const INDEX = `# Programme\n\n${ROWS_MARKER}\n| Month | Type | Version | Findings | Result | Summary |\n|---|---|---|---|---|---|\n`;

function deps({ files = {}, env = {}, existing = { issues: [], advisories: [] } } = {}) {
  const written = {};
  const lines = [];
  const created = [];
  const clientArgs = [];
  return {
    written,
    lines,
    created,
    clientArgs,
    readFile: p => {
      const key = p.replace(/\\/g, '/');
      if (written[key] !== undefined) return written[key];
      if (files[key] === undefined) throw new Error(`ENOENT ${key}`);
      return files[key];
    },
    writeFile: (p, s) => { written[p.replace(/\\/g, '/')] = s; },
    env,
    log: line => lines.push(line),
    createClient: args => {
      clientArgs.push(args);
      return {
        listIssues: async () => existing.issues,
        listAdvisories: async () => existing.advisories,
        createIssue: async body => { created.push(['issue', body.title]); return { html_url: 'https://github.com/o/r/issues/50', node_id: 'I_50' }; },
        createAdvisory: async body => { created.push(['advisory', body.summary]); return { html_url: 'https://gh/advisories/GHSA-x' }; },
      };
    },
  };
}

const findingsJson = JSON.stringify(report([
  finding({ fingerprint: 'high-one', severity: 'High' }),
  finding({ fingerprint: 'low-one' }),
]));

describe('security review cli', () => {
  it('prints usage for an unknown command or missing arguments', async () => {
    for (const argv of [[], ['nope', 'f.json'], ['validate']]) {
      const d = deps();
      expect(await main(argv, d)).toBe(2);
      expect(d.lines[0]).toMatch(/^usage:/);
    }
    const d = deps({ files: { 'f.json': findingsJson } });
    expect(await main(['file', 'f.json'], d)).toBe(2);
    expect(await main(['publish', 'f.json', 'filings.json'], d)).toBe(2);
  });

  it('rejects a findings file that is not JSON or not valid', async () => {
    const d = deps({ files: { 'bad.json': '{nope', 'wrong.json': '{"reviewId":"x"}' } });
    expect(await main(['validate', 'bad.json'], d)).toBe(1);
    expect(d.lines[0]).toMatch(/^invalid: bad\.json is not readable JSON/);
    expect(await main(['validate', 'missing.json'], d)).toBe(1);
    expect(await main(['validate', 'wrong.json'], d)).toBe(1);
    expect(d.lines).toContain('invalid: reviewId must look like 2026-12');
  });

  it('validates a good file', async () => {
    const d = deps({ files: { 'f.json': findingsJson } });
    expect(await main(['validate', 'f.json'], d)).toBe(0);
    expect(d.lines).toEqual(['f.json is valid: 2 findings']);
  });

  it('prints the plan and files nothing on a dry run', async () => {
    const d = deps({ files: { 'f.json': findingsJson }, existing: { issues: [{ state: 'open', body: marker('low-one'), html_url: 'https://gh/issues/8' }], advisories: [] } });
    expect(await main(['file', 'f.json', 'filings.json', '--dry-run'], d)).toBe(0);
    expect(d.created).toEqual([]);
    expect(d.written).toEqual({});
    expect(d.lines).toEqual([
      'SR-2026-12-01 High: new advisory + placeholder issue',
      'SR-2026-12-02 Low: already tracked (https://gh/issues/8)',
    ]);
  });

  it('files new findings with the configured repo and board and records where each one is tracked', async () => {
    const env = { GH_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', SECURITY_BOARD_PROJECT_ID: 'PVT_9', REVIEW_URL: 'https://run/5' };
    const existing = { issues: [{ state: 'closed', body: marker('low-one'), html_url: 'https://gh/issues/8' }], advisories: [] };
    const d = deps({ files: { 'f.json': findingsJson }, env, existing });
    expect(await main(['file', 'f.json', 'filings.json'], d)).toBe(0);
    expect(d.clientArgs).toEqual([{ token: 'tok', repo: 'o/r', projectId: 'PVT_9' }]);
    expect(d.lines[1]).toBe('SR-2026-12-02 Low: new public issue (regression)');
    expect(d.created).toEqual([
      ['advisory', 'Title of high-one'],
      ['issue', 'Security review SR-2026-12-01: High finding (tracked privately)'],
      ['issue', '[Security review] Title of low-one'],
    ]);
    const filings = JSON.parse(d.written['filings.json']);
    expect(filings['high-one']).toEqual({ issueUrl: 'https://github.com/o/r/issues/50', advisoryUrl: 'https://gh/advisories/GHSA-x', isNew: true });
  });

  it('writes the public page and adds it to the index', async () => {
    const filings = JSON.stringify({ 'high-one': { issueUrl: 'https://github.com/o/r/issues/50' } });
    const d = deps({ files: { 'f.json': findingsJson, 'filings.json': filings, 'docs/security/index.md': INDEX } });
    expect(await main(['publish', 'f.json', 'filings.json', 'docs/security'], d)).toBe(0);
    expect(d.written['docs/security/review-2026-12.md']).toContain('| SR-2026-12-01 | High | A05 | Details withheld until fixed | [#50](https://github.com/o/r/issues/50) |');
    expect(d.written['docs/security/index.md']).toContain('[Review, December 2026](review-2026-12.md)');
    expect(d.lines).toEqual(['Wrote review-2026-12.md and updated index.md']);
  });
});
