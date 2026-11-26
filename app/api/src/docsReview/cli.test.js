import { describe, expect, it } from 'vitest';
import { defaultDeps, main } from './cli.js';
import { marker } from './filings.js';

const finding = (fingerprint, docPath = 'docs/a.md') => ({
  fingerprint,
  kind: 'Missing',
  docPath,
  title: `Title ${fingerprint}`,
  docSays: 'nothing',
  codeDoes: 'something',
  evidence: 'app/api/src/x.js:1',
  suggestion: 'write it',
});

const report = findings => JSON.stringify({ reviewId: '2026-12', commit: 'abcdef1', checked: ['docs/', 'ontology/'], findings });

function harness({ file, pages = ['docs/a.md'], issues = [], env = {} }) {
  const logs = [];
  const created = [];
  let clientArgs;
  const deps = {
    readFile: () => file,
    exists: p => pages.includes(p),
    env: { GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', REVIEW_URL: 'https://run/9', ...env },
    createClient: args => {
      clientArgs = args;
      return {
        listIssues: async () => issues,
        createIssue: async i => { created.push(i); return { html_url: `https://gh/new/${created.length}` }; },
      };
    },
    log: l => logs.push(l),
  };
  return { deps, logs, created, clientArgs: () => clientArgs };
}

describe('docs audit cli', () => {
  it('prints usage and exits 2 for an unknown command or a missing path', async () => {
    const h = harness({ file: '' });
    expect(await main(['publish', 'f.json'], h.deps)).toBe(2);
    expect(await main(['validate'], h.deps)).toBe(2);
    expect(h.logs).toEqual([expect.stringMatching(/^usage:/), expect.stringMatching(/^usage:/)]);
  });

  it('validates a good file and exits 0 without touching GitHub', async () => {
    const h = harness({ file: report([finding('docs:a:one-1')]) });
    expect(await main(['validate', 'f.json'], h.deps)).toBe(0);
    expect(h.logs).toEqual(['f.json is valid: 1 findings']);
    expect(h.clientArgs()).toBeUndefined();
  });

  it('exits 1 with every problem for a bad file, and for unreadable JSON', async () => {
    const bad = harness({ file: report([{ ...finding('docs:a:one-1'), kind: 'Nope' }]) });
    expect(await main(['file', 'f.json'], bad.deps)).toBe(1);
    expect(bad.logs).toEqual(['invalid: findings[0]: kind must be one of Wrong, Stale, Missing']);
    expect(bad.created).toEqual([]);

    const junk = harness({ file: '{not json' });
    expect(await main(['validate', 'f.json'], junk.deps)).toBe(1);
    expect(junk.logs[0]).toMatch(/^invalid: f\.json is not readable JSON/);
  });

  it('files new findings with the docs label and assignees, skips tracked ones, drops pages that do not exist', async () => {
    const h = harness({
      file: report([finding('docs:a:new-1'), finding('docs:a:old-2'), finding('docs:a:gone-3', 'docs/ghost.md')]),
      issues: [{ state: 'open', body: marker('docs:a:old-2'), html_url: 'https://gh/7' }],
      env: { DOCS_REVIEW_ASSIGNEES: 'wim, taeke ,' },
    });
    expect(await main(['file', 'f.json'], h.deps)).toBe(0);
    expect(h.clientArgs()).toEqual({ token: 't', repo: 'o/r', issueLabel: 'ai-docs-review' });
    expect(h.created.map(i => [i.title, i.assignees])).toEqual([['[Docs audit] Title docs:a:new-1', ['wim', 'taeke']]]);
    expect(h.created[0].body).toContain('(https://run/9)');
    expect(h.logs).toEqual([
      'DA-2026-12-03 dropped: docs/ghost.md does not exist',
      'DA-2026-12-01 Missing docs/a.md: https://gh/new/1',
      'DA-2026-12-02 Missing docs/a.md: already tracked (https://gh/7)',
      '1 new issues; reviewed 2 areas',
    ]);
  });

  it('files nothing on --dry-run but still prints the plan', async () => {
    const h = harness({ file: report([finding('docs:a:new-1')]) });
    expect(await main(['file', 'f.json', '--dry-run'], h.deps)).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.logs).toEqual(['DA-2026-12-01 Missing docs/a.md: new issue', '0 new issues (dry run: nothing filed); reviewed 2 areas']);
  });

  it('assigns nobody when no assignees are configured', async () => {
    const h = harness({ file: report([finding('docs:a:new-1')]), env: { REVIEW_URL: undefined } });
    await main(['file', 'f.json'], h.deps);
    expect(h.created[0].assignees).toEqual([]);
    expect(h.created[0].body).toContain('DA-2026-12-01 ().');
  });
});

describe('docs audit cli: real file system', () => {
  it('reads files and checks pages relative to the working directory', () => {
    expect(defaultDeps.exists('package.json')).toBe(true);
    expect(defaultDeps.exists('docs/no-such-page.md')).toBe(false);
    expect(JSON.parse(defaultDeps.readFile('package.json')).name).toBeTruthy();
  });
});
