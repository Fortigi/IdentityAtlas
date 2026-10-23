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
