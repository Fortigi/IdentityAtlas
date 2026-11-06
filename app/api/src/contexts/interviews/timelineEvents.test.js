// What a context's interviews add to its timeline — each kind of event, worded.
import { describe, it, expect, vi } from 'vitest';
import { interviewTimelineEvents, loadInterviewTimeline } from './timelineEvents.js';
import { TIMELINE_INTERVIEWS_SQL, TIMELINE_DECISIONS_SQL } from './store.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const src = { intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' };
const decided = (over) => ({ id: 'c', status: 'confirmed', decidedAt: '2026-10-02T10:00:00Z', ...src, ...over });

describe('interviewTimelineEvents', () => {
  it('an upload, and its extraction only when it proposed something', () => {
    const out = interviewTimelineEvents({ interviews: [
      { intervieweeName: 'Anna Voorbeeld', fileName: 'a.txt', createdAt: '2026-10-01T08:00:00Z', extracted: 1, extractedAt: '2026-10-01T08:03:00Z' },
      { intervieweeName: 'Bram Bakker', fileName: 'b.vtt', createdAt: '2026-10-01T07:00:00Z', extracted: 0, extractedAt: null },
    ] });
    expect(out.map(e => [e.operation, e.summary])).toEqual([
      ['changed', '1 claim extracted from the interview with Anna Voorbeeld'],
      ['added', 'Interview with Anna Voorbeeld uploaded (a.txt)'],
      ['added', 'Interview with Bram Bakker uploaded (b.vtt)'],
    ]);
    expect(out.every(e => e.eventKind === 'interview')).toBe(true);
  });

  it('a confirmed claim that changed the context reads as that change', () => {
    const out = interviewTimelineEvents({ decisions: [
      decided({ claimKind: 'alias', value: 'Havenkantoor', decidedAt: '2026-10-02T13:00:00Z' }),
      decided({ claimKind: 'property', attribute: 'sector', value: 'logistics', decidedAt: '2026-10-02T12:00:00Z' }),
      decided({ claimKind: 'description', value: 'Runs the quays.', status: 'edited', decidedAt: '2026-10-02T11:00:00Z' }),
    ] });
    expect(out.map(e => e.summary)).toEqual([
      'Also known as: Havenkantoor added — from the interview with Anna Voorbeeld, 2026-10-01',
      'sector set to logistics — from the interview with Anna Voorbeeld, 2026-10-01',
      'Description extended — from the interview with Anna Voorbeeld, 2026-10-01',
    ]);
    expect(out[2].detail).toBe('Runs the quays.');
  });

  it('a role set from a claim names its holder, linked as an account or a person; without a holder the subject', () => {
    const [acc] = interviewTimelineEvents({ decisions: [decided({ claimKind: 'role', appliedRole: 'Accountable', roleHolderName: 'Piet Proef', roleHolderId: 'p1', roleHolderIsAccount: true })] });
    expect(acc).toMatchObject({ operation: 'added', summary: 'Piet Proef set as Accountable — from the interview with Anna Voorbeeld, 2026-10-01', counterpartyKind: 'user', counterpartyId: 'p1', counterpartyLabel: 'Piet Proef' });
    const [person] = interviewTimelineEvents({ decisions: [decided({ claimKind: 'role', appliedRole: 'Responsible', roleHolderName: 'Joke Jansen', roleHolderId: 'i1', roleHolderIsAccount: false })] });
    expect(person.counterpartyKind).toBe('identity');
    const [noHolder] = interviewTimelineEvents({ decisions: [decided({ claimKind: 'role', appliedRole: 'Responsible', subjectName: 'Kees' })] });
    expect(noHolder).toMatchObject({ summary: 'Kees set as Responsible — from the interview with Anna Voorbeeld, 2026-10-01', counterpartyKind: null });
  });

  it('other decisions: Confirmed / Confirmed (edited) / Rejected, with the kind and what it said', () => {
    const out = interviewTimelineEvents({ decisions: [
      decided({ claimKind: 'membership', attribute: 'rejoined', subjectDisplayName: 'Jan Smit', decidedAt: '2026-10-02T15:00:00Z' }),
      decided({ claimKind: 'roleHistory', subjectName: 'Piet', value: 'junior', status: 'edited', decidedAt: '2026-10-02T14:00:00Z' }),
      decided({ claimKind: 'property', attribute: 'vendor', value: 'Acme', status: 'rejected', decidedAt: '2026-10-02T13:00:00Z' }),
      decided({ claimKind: 'description', value: 'small talk', status: 'rejected', decidedAt: '2026-10-02T12:00:00Z' }),
      decided({ claimKind: 'membership', attribute: 'odd', subjectName: 'Ruud', status: 'rejected', decidedAt: '2026-10-02T11:00:00Z' }),
    ] });
    expect(out.map(e => e.summary)).toEqual([
      'Confirmed: Membership — Jan Smit (back again (rejoined)) — from the interview with Anna Voorbeeld, 2026-10-01',
      'Confirmed (edited): Role history — Piet: junior — from the interview with Anna Voorbeeld, 2026-10-01',
      'Rejected: Property — vendor: Acme — from the interview with Anna Voorbeeld, 2026-10-01',
      'Rejected: Description — small talk — from the interview with Anna Voorbeeld, 2026-10-01',
      'Rejected: Membership — Ruud (odd) — from the interview with Anna Voorbeeld, 2026-10-01',
    ]);
  });
});

describe('loadInterviewTimeline', () => {
  const fakeDb = () => ({ query: vi.fn(async (sql) => ({ rows: sql === TIMELINE_INTERVIEWS_SQL ? [{ intervieweeName: 'A', fileName: 'f', createdAt: '2026-10-01T00:00:00Z', extracted: 0 }] : [] })) });

  it('an analyst: the uploads and every decision, rejected included', async () => {
    const db = fakeDb();
    const out = await loadInterviewTimeline(db, CTX, { sinceDays: 90, limit: 50, canWrite: true });
    expect(db.query.mock.calls).toEqual([[TIMELINE_INTERVIEWS_SQL, [CTX, 90]], [TIMELINE_DECISIONS_SQL, [CTX, 90, ['confirmed', 'edited', 'rejected'], 50]]]);
    expect(out).toHaveLength(1);
  });

  it('a reader: no uploads, confirmed decisions only', async () => {
    const db = fakeDb();
    await loadInterviewTimeline(db, CTX, { sinceDays: 30, limit: 10, canWrite: false });
    expect(db.query.mock.calls).toEqual([[TIMELINE_DECISIONS_SQL, [CTX, 30, ['confirmed', 'edited'], 10]]]);
  });

  it('the decisions statement reads the role a claim set and stays in the window', () => {
    expect(TIMELINE_DECISIONS_SQL).toMatch(/x."sourceClaimId" = c.id/);
    expect(TIMELINE_DECISIONS_SQL).toMatch(/c."decidedAt" > now\(\) - \(\$2::int \|\| ' days'\)::interval/);
    expect(TIMELINE_INTERVIEWS_SQL).toMatch(/FILTER \(WHERE c."proposedBy" = 'model'\)/);
  });
});

describe('a decided contradiction on the timeline', () => {
  const con = (over) => ({
    id: 'leftButMember:c-1', claimIds: ['c-1'], status: 'decided', resolution: 'interview', decidedAt: '2026-10-02T10:00:00Z',
    claim: { statement: 'Interview: Lotte Lindeboom left' }, other: { kind: 'fact', statement: 'HR export still lists Lotte Lindeboom as a member' }, ...over,
  });
  const row = (over) => decided({ id: 'c-1', claimKind: 'membership', attribute: 'left', subjectName: 'Lotte', ...over });

  it('reads as "Decided: <claim> · <fact> — <how>" instead of the plain decision', () => {
    const [ev] = interviewTimelineEvents({ decisions: [row()], contradictions: [con()] });
    expect(ev).toMatchObject({ summary: 'Decided: Interview: Lotte Lindeboom left · HR export still lists Lotte Lindeboom as a member — the interview is right', contradictionId: 'leftButMember:c-1' });
  });

  it('a decision that marked a member former says so, with the source it overrides', () => {
    const marked = row({ subjectDisplayName: 'Led Ledeboer', overridesSource: 'Klanten (upload)' });
    const [ev] = interviewTimelineEvents({ decisions: [marked], contradictions: [con()] });
    expect(ev).toMatchObject({ summary: 'Decided: Led Ledeboer is a former member (overrides Klanten (upload))', contradictionId: 'leftButMember:c-1' });
    const [plain] = interviewTimelineEvents({ decisions: [marked] });
    expect(plain.summary).toBe('Decided: Led Ledeboer is a former member (overrides Klanten (upload))');
    expect(plain.contradictionId).toBeUndefined();
    expect(TIMELINE_DECISIONS_SQL).toContain('LEFT JOIN "ContextMemberOverrides" o ON o."claimId" = c.id');
  });

  it('each way of deciding is worded', async () => {
    const { resolutionWords } = await import('./timelineEvents.js');
    const pairCon = { claim: { statement: 'A' }, other: { kind: 'claim', statement: 'B' } };
    expect(['interview', 'source', 'both', 'first', 'second', 'neither'].map(resolution => resolutionWords({ ...pairCon, resolution }))).toEqual([
      'the interview is right', 'what we had is right', 'both true, at different times', 'kept “A”', 'kept “B”', 'neither',
    ]);
  });

  it('a pair reads once, on its last decision; an open contradiction changes nothing', () => {
    const pairCon = con({ id: 'claims:c-1+c-2', claimIds: ['c-1', 'c-2'], resolution: 'both', decidedAt: '2026-10-03T10:00:00Z' });
    const out = interviewTimelineEvents({ decisions: [row({ decidedAt: '2026-10-02T10:00:00Z' }), row({ id: 'c-2', attribute: 'current', decidedAt: '2026-10-03T10:00:00Z' })], contradictions: [pairCon] });
    expect(out.map(e => e.summary.split(' — ')[0])).toEqual([
      'Decided: Interview: Lotte Lindeboom left · HR export still lists Lotte Lindeboom as a member',
      'Confirmed: Membership',
    ]);
    const open = interviewTimelineEvents({ decisions: [row()], contradictions: [con({ status: 'open' })] });
    expect(open[0].summary).toMatch(/^Confirmed: Membership/);
  });

  it('the loader reads the claims and facts for it only when something was decided', async () => {
    const decisionRow = row();
    const db = { query: vi.fn(async (sql) => ({ rows: sql === TIMELINE_DECISIONS_SQL ? [decisionRow] : [] })), queryOne: vi.fn() };
    await loadInterviewTimeline(db, CTX, { sinceDays: 90, limit: 50, canWrite: false });
    const sqls = db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes('FROM "ContextClaims" c') && s.includes('c."claimStatus" = ANY($2::text[])'))).toBe(true);
    expect(db.query.mock.calls.find(c => c[0].includes('ORDER BY iv."interviewedAt" DESC, c."createdAt"'))[1]).toEqual([CTX, ['confirmed', 'edited'], []]);
  });
});
