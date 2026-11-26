import { describe, expect, it } from 'vitest';
import { describePlan, executeFilings, issueFor, LABELS, marker, MAX_NEW_ISSUES, planFilings } from './filings.js';

const finding = (fingerprint, over = {}) => ({
  id: `DA-2026-12-${fingerprint.slice(-2)}`,
  fingerprint,
  kind: 'Stale',
  docPath: 'docs/reference/permissions.md',
  title: 'Permissions page misses the relative-permission grid',
  docSays: 'Owners get one fixed set of permissions.',
  codeDoes: 'Each template has its own Accountable/Responsible grid.',
  evidence: 'app/api/src/contexts/relativePermissions.js:12',
  suggestion: 'Add a section on the grid.',
  ...over,
});

const issue = (fp, over) => ({ number: 1, state: 'open', state_reason: null, html_url: `https://gh/i/${fp}`, body: `x\n${marker(fp)}\ny`, ...over });

describe('marker', () => {
  it('holds a hash, not the fingerprint, and differs per fingerprint', () => {
    expect(marker('docs:a:one-thing')).toMatch(/^<!-- ia-docs-review:fp=[0-9a-f]{24} -->$/);
    expect(marker('docs:a:one-thing')).not.toContain('one-thing');
    expect(marker('docs:a:one-thing')).not.toBe(marker('docs:a:two-thing'));
  });
});

describe('planFilings', () => {
  it('decides per finding from the issues that carry its marker', () => {
    const plan = planFilings(
      [finding('docs:x:open01'), finding('docs:x:nope02'), finding('docs:x:done03'), finding('docs:x:news04')],
      [
        issue('docs:x:open01'),
        issue('docs:x:nope02', { state: 'closed', state_reason: 'not_planned' }),
        issue('docs:x:done03', { state: 'closed', state_reason: 'completed' }),
        // Someone else's issue that merely mentions the doc: no marker, no match.
        { number: 9, state: 'open', body: 'docs:x:news04', html_url: 'u' },
      ],
    );
    expect(plan.map(e => [e.finding.fingerprint, e.action, e.existing?.html_url ?? e.recurrenceOf?.html_url ?? null])).toEqual([
      ['docs:x:open01', 'known', 'https://gh/i/docs:x:open01'],
      ['docs:x:nope02', 'dismissed', 'https://gh/i/docs:x:nope02'],
      ['docs:x:done03', 'create', 'https://gh/i/docs:x:done03'],
      ['docs:x:news04', 'create', null],
    ]);
  });

  it('treats an open issue as tracking it even when an older one was dismissed', () => {
    const fp = 'docs:x:both01';
    const plan = planFilings([finding(fp)], [issue(fp, { state: 'closed', state_reason: 'not_planned' }), issue(fp, { html_url: 'open-one' })]);
    expect(plan[0]).toMatchObject({ action: 'known', existing: { html_url: 'open-one' } });
  });

  it('ignores issues without a body', () => {
    expect(planFilings([finding('docs:x:body01')], [{ state: 'open', body: null }])[0].action).toBe('create');
  });

  it('opens at most MAX_NEW_ISSUES and defers the rest, not counting known ones against the limit', () => {
    const fps = Array.from({ length: MAX_NEW_ISSUES + 3 }, (_, i) => `docs:x:n${String(i).padStart(4, '0')}`);
    const plan = planFilings(fps.map(fp => finding(fp)), [issue(fps[0])]);
    const count = a => plan.filter(e => e.action === a).length;
    expect([count('known'), count('create'), count('deferred')]).toEqual([1, MAX_NEW_ISSUES, 2]);
    expect(plan.at(-1).action).toBe('deferred');
    expect(plan[1].action).toBe('create');
  });
});

describe('issueFor', () => {
  it('writes a parked documentation bug that carries the marker and links the run', () => {
    const f = finding('docs:x:body02');
    const out = issueFor({ finding: f, action: 'create' }, 'https://run/1', ['wim']);
    expect(out).toEqual({ title: '[Docs audit] Permissions page misses the relative-permission grid', body: expect.any(String), labels: LABELS, assignees: ['wim'] });
    expect(LABELS).toEqual(['documentation', 'bug', 'ai-docs-review', 'needs-vouch']);
    expect(out.body.startsWith(marker(f.fingerprint))).toBe(true);
    expect(out.body).toContain('**Stale** · `docs/reference/permissions.md`');
    expect(out.body).toContain('## What the code does\n\nEach template has its own');
    expect(out.body).toContain('DA-2026-12-02 (https://run/1)');
    expect(out.body).not.toContain('Came back');
    expect(out.body).not.toContain('\n\n\n\n');
  });

  it('says when a fixed problem came back', () => {
    const out = issueFor({ finding: finding('docs:x:back03'), recurrenceOf: { html_url: 'https://gh/i/7' } }, 'r');
    expect(out.body).toContain('**Came back.** This was filed before as https://gh/i/7');
    expect(out.assignees).toEqual([]);
  });
});

describe('describePlan', () => {
  it('says what happened to each finding, with the filed url when there is one', () => {
    const lines = describePlan([
      { finding: finding('docs:x:k0001'), action: 'known', existing: { html_url: 'K' } },
      { finding: finding('docs:x:d0002'), action: 'dismissed', existing: { html_url: 'D' } },
      { finding: finding('docs:x:f0003'), action: 'deferred' },
      { finding: finding('docs:x:c0004'), action: 'create' },
      { finding: finding('docs:x:r0005'), action: 'create', recurrenceOf: { html_url: 'R' } },
      { finding: finding('docs:x:n0006'), action: 'create' },
    ], { 'docs:x:n0006': 'https://gh/new' });
    expect(lines).toEqual([
      'DA-2026-12-01 Stale docs/reference/permissions.md: already tracked (K)',
      'DA-2026-12-02 Stale docs/reference/permissions.md: dismissed earlier (D), not filed',
      `DA-2026-12-03 Stale docs/reference/permissions.md: over this run's limit of ${MAX_NEW_ISSUES} new issues, left for the next run`,
      'DA-2026-12-04 Stale docs/reference/permissions.md: new issue',
      'DA-2026-12-05 Stale docs/reference/permissions.md: new issue (came back)',
      'DA-2026-12-06 Stale docs/reference/permissions.md: https://gh/new',
    ]);
  });
});

describe('executeFilings', () => {
  it('creates issues only for the findings planned as create, in order', async () => {
    const created = [];
    const client = { createIssue: async i => { created.push(i.title); return { html_url: `u${created.length}` }; } };
    const plan = [
      { finding: finding('docs:x:a0001', { title: 'A' }), action: 'create' },
      { finding: finding('docs:x:b0002', { title: 'B' }), action: 'known', existing: {} },
      { finding: finding('docs:x:c0003', { title: 'C' }), action: 'deferred' },
      { finding: finding('docs:x:d0004', { title: 'D' }), action: 'create' },
    ];
    expect(await executeFilings(plan, client, 'r')).toEqual({ 'docs:x:a0001': 'u1', 'docs:x:d0004': 'u2' });
    expect(created).toEqual(['[Docs audit] A', '[Docs audit] D']);
  });
});
