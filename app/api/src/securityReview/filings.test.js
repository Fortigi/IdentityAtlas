import { describe, expect, it } from 'vitest';
import { advisory, executeFilings, marker, placeholderIssue, planFilings, publicIssue } from './filings.js';
import { finding } from './__mocks__/sampleReport.js';

const low = finding({ fingerprint: 'low-finding', severity: 'Low', id: 'SR-2026-12-02' });
const high = finding({ fingerprint: 'high-finding', severity: 'High', owasp: 'A01', id: 'SR-2026-12-01' });

const issue = (number, state, fp) => ({ number, state, body: `text\n${marker(fp)}`, html_url: `https://gh/issues/${number}`, node_id: `I_${number}` });
const adv = (id, state, fp) => ({ ghsa_id: id, state, description: marker(fp), html_url: `https://gh/advisories/${id}` });

describe('planFilings', () => {
  it('files a new Low finding as a public issue', () => {
    const [entry] = planFilings([low], { issues: [], advisories: [] });
    expect(entry).toMatchObject({ action: 'create', private: false });
    expect(entry.regressionOf).toBeUndefined();
  });

  it('recognises a Low finding that already has an open issue', () => {
    const [entry] = planFilings([low], { issues: [issue(7, 'open', 'low-finding')] });
    expect(entry.action).toBe('known');
    expect(entry.existing.number).toBe(7);
  });

  it('files a Low finding again as a regression when its issue was closed', () => {
    const [entry] = planFilings([low], { issues: [issue(7, 'closed', 'low-finding')] });
    expect(entry.action).toBe('create');
    expect(entry.regressionOf.number).toBe(7);
  });

  it('does not match a different fingerprint, even one that starts with the same text', () => {
    const [entry] = planFilings([low], { issues: [issue(9, 'open', 'low-finding-2')] });
    expect(entry.action).toBe('create');
  });

  it('keeps the fingerprint itself out of the marker, because placeholder issues are public', () => {
    const m = marker('api:routes/export.js:formula');
    expect(m).toMatch(/^<!-- ia-security-review:fp=[0-9a-f]{24} -->$/);
    expect(m).not.toContain('export');
    expect(marker('api:routes/export.js:formula')).toBe(m);
    expect(marker('api:routes/export.js:formulb')).not.toBe(m);
  });

  it('files Medium and above privately, never as a public write-up', () => {
    for (const severity of ['Critical', 'High', 'Medium']) {
      const [entry] = planFilings([finding({ severity })], {});
      expect(entry).toMatchObject({ private: true, action: 'create' });
    }
  });

  it('recognises a private finding with an open advisory and keeps its placeholder issue', () => {
    const [entry] = planFilings([high], {
      issues: [issue(3, 'closed', 'high-finding'), issue(4, 'open', 'high-finding')],
      advisories: [adv('GHSA-a', 'triage', 'high-finding')],
    });
    expect(entry.action).toBe('known');
    expect(entry.existing.ghsa_id).toBe('GHSA-a');
    expect(entry.placeholder.number).toBe(4);
  });

  it('files a private finding again when its advisory was published or closed', () => {
    const [entry] = planFilings([high], { advisories: [adv('GHSA-b', 'published', 'high-finding')] });
    expect(entry.action).toBe('create');
    expect(entry.regressionOf.ghsa_id).toBe('GHSA-b');
  });

  it('ignores an open issue for a private finding when deciding whether it is known', () => {
    // Only the advisory decides: an orphan placeholder must not hide a finding with no advisory.
    const [entry] = planFilings([high], { issues: [issue(4, 'open', 'high-finding')], advisories: [] });
    expect(entry.action).toBe('create');
  });
});

describe('issue and advisory bodies', () => {
  it('puts the full write-up in a public issue for a Low finding', () => {
    const out = publicIssue({ finding: low }, 'https://run/1');
    expect(out.title).toBe('[Security review] Title of low-finding');
    for (const text of ['Secret description', 'Impact of', 'Remediation of', 'Evidence of', 'component-of-low-finding', 'CWE-1236', 'https://run/1']) {
      expect(out.body).toContain(text);
    }
    expect(out.body.startsWith(marker('low-finding'))).toBe(true);
    // Filed as a parked Bug: the bug pipeline starts only after a maintainer vouches.
    expect(out.labels).toEqual(['security', 'ai-security-review', 'severity:low', 'bug', 'needs-vouch']);
    expect(out.type).toBe('Bug');
    expect(out.assignees).toEqual([]);
    expect(out.body).toContain('apply `dor-vouched`');
    expect(out.body).not.toContain('Regression');
  });

  it('marks a regression with the earlier filing', () => {
    const out = publicIssue({ finding: low, regressionOf: { html_url: 'https://gh/issues/7' } }, '');
    expect(out.body).toContain('filed before as https://gh/issues/7');
    expect(out.body).toContain('found it again as SR-2026-12-02');
  });

  it('leaves the details out of the public placeholder for a private finding', () => {
    const out = placeholderIssue({ finding: high }, 'https://gh/advisories/GHSA-a');
    expect(out.title).toBe('Security review SR-2026-12-01: High finding (tracked privately)');
    expect(out.body).toContain('https://gh/advisories/GHSA-a');
    expect(out.body).toContain('OWASP A01 Broken Access Control');
    for (const leak of ['Title of', 'Secret description', 'Impact of', 'Remediation of', 'Evidence of', 'component-of', 'Public summary']) {
      expect(out.body).not.toContain(leak);
    }
    expect(out.labels).toContain('severity:high');
    // Never handed to the public bug pipeline: no bug label, no vouch label.
    expect(out.labels).not.toContain('bug');
    expect(out.labels).not.toContain('needs-vouch');
    expect(out.type).toBe('Bug');
  });

  it('puts the full write-up in the private advisory', () => {
    const out = advisory({ finding: high }, 'https://run/1');
    expect(out).toMatchObject({ summary: 'Title of high-finding', severity: 'high', cwe_ids: ['CWE-1236'] });
    expect(out.vulnerabilities).toEqual([{ package: { ecosystem: 'other', name: 'identity-atlas' } }]);
    expect(out.description).toContain('Evidence of high-finding');
    expect(out.description).toContain(marker('high-finding'));
  });

  it('sends an empty CWE list when the finding has none', () => {
    const noCwe = { ...high, cwe: undefined };
    expect(advisory({ finding: noCwe }, '').cwe_ids).toEqual([]);
    expect(publicIssue({ finding: { ...low, cwe: [] } }, '').body).toContain('OWASP A05 Injection · `component');
  });
});

function fakeClient({ board = true } = {}) {
  const calls = [];
  let next = 100;
  const client = {
    calls,
    createIssue: async body => {
      calls.push(['issue', body]);
      next += 1;
      return { html_url: `https://gh/issues/${next}`, node_id: `I_${next}` };
    },
    createAdvisory: async body => {
      calls.push(['advisory', body]);
      return { html_url: 'https://gh/advisories/GHSA-new' };
    },
  };
  if (board) client.addToBoard = async id => calls.push(['board', id]);
  return client;
}

describe('executeFilings', () => {
  it('creates the advisory first and links it from the placeholder issue, then adds the issue to the board', async () => {
    const client = fakeClient();
    const result = await executeFilings(planFilings([high], {}), client, 'https://run/1');
    expect(client.calls.map(c => c[0])).toEqual(['advisory', 'issue', 'board']);
    expect(client.calls[1][1].body).toContain('https://gh/advisories/GHSA-new');
    expect(client.calls[2][1]).toBe('I_101');
    expect(result).toEqual({
      'high-finding': { issueUrl: 'https://gh/issues/101', advisoryUrl: 'https://gh/advisories/GHSA-new', isNew: true },
    });
  });

  it('files nothing for findings that are already tracked, and reports where they are tracked', async () => {
    const client = fakeClient();
    const plan = planFilings([high, low], {
      issues: [issue(4, 'open', 'high-finding'), issue(8, 'open', 'low-finding')],
      advisories: [adv('GHSA-a', 'draft', 'high-finding')],
    });
    const result = await executeFilings(plan, client, '');
    expect(client.calls).toEqual([]);
    expect(result['high-finding']).toEqual({ issueUrl: 'https://gh/issues/4', advisoryUrl: 'https://gh/advisories/GHSA-a', isNew: false });
    expect(result['low-finding']).toEqual({ issueUrl: 'https://gh/issues/8', isNew: false });
  });

  it('files a private finding without a board when none is configured', async () => {
    const client = fakeClient({ board: false });
    await executeFilings(planFilings([high], {}), client, '');
    expect(client.calls.map(c => c[0])).toEqual(['advisory', 'issue']);
  });

  it('reports a known private finding without a placeholder issue as having no issue', async () => {
    const plan = planFilings([high], { advisories: [adv('GHSA-a', 'draft', 'high-finding')] });
    const result = await executeFilings(plan, fakeClient(), '');
    expect(result['high-finding'].issueUrl).toBeNull();
  });

  it('assigns new issues to the given maintainers, both kinds', async () => {
    const client = fakeClient();
    await executeFilings(planFilings([high, low], {}), client, '', { assignees: ['alice', 'bob'] });
    const issues = client.calls.filter(c => c[0] === 'issue').map(c => c[1].assignees);
    expect(issues).toEqual([['alice', 'bob'], ['alice', 'bob']]);
  });

  it('creates a public Bug issue for a new Low finding without putting it on the board itself', async () => {
    // The vouch puts it on the Bug Pipeline board with its status; adding it here would race that.
    const client = fakeClient();
    const result = await executeFilings(planFilings([low], {}), client, '');
    expect(client.calls.map(c => c[0])).toEqual(['issue']);
    expect(client.calls[0][1].body).toContain('Secret description of low-finding');
    expect(result['low-finding']).toEqual({ issueUrl: 'https://gh/issues/101', isNew: true });
  });
});
