// The three activity-based templates, together.
//
// One file because they share `activityWindow.js` and are tested against the
// same question: does the SQL actually constrain what the report claims to
// list, and are the numbers derived from the measurement moment rather than
// from today? The mocked db is SQL-blind, so the assertions here are on the
// PREDICATES the templates emit and the values they bind — those are the parts
// a refactor can silently drop. Whether the SQL runs is the contract test's job.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import staleAccounts from './stale-accounts.js';
import neverSignedIn from './never-signed-in.js';
import staleGuests from './stale-guest-accounts.js';

const MEASURED = '2026-09-16T02:00:00.000Z';

// Stage the two queries every activity report makes, in order: the report's own
// rows, then fetchMeasurementMoments() for the notices.
function stage(rows, moments = [{ systemName: 'Entra ID', measuredAt: MEASURED }]) {
  query.mockReset();
  query.mockResolvedValueOnce({ rows });
  query.mockResolvedValueOnce({ rows: moments });
}

const reportSql = () => String(query.mock.calls[0][0]);
const reportParams = () => query.mock.calls[0][1];

beforeEach(() => { query.mockReset(); });

describe.each([
  ['stale-accounts', staleAccounts, 90],
  ['never-signed-in', neverSignedIn, 30],
  ['stale-guest-accounts', staleGuests, 30],
])('%s — shared activity-report contract', (name, report, defaultDays) => {
  it('declares itself as a list with a days parameter defaulting to its threshold', () => {
    expect(report).toMatchObject({ name, form: 'list' });
    expect(report.parametersSchema.properties.days.default).toBe(defaultDays);
    expect(report.parametersSchema.required).toEqual([]);
  });

  it('carries the measurement moment as a COLUMN, not only as a notice', () => {
    // Notices are screen-only; a downloaded file has to be self-describing, so
    // "measured on" must be readable from the rows themselves.
    expect(report.columns.map(c => c.key)).toContain('measuredOn');
  });

  it('binds the threshold rather than interpolating it into the SQL', async () => {
    stage([]);
    await report.run({ days: '45' }, {});
    expect(reportParams()[0]).toBe(45);
    expect(reportSql()).toContain('make_interval(days => $1)');
  });

  it('falls back to the default for an unusable threshold instead of erroring', async () => {
    stage([]);
    await expect(report.run({ days: 'soon' }, {})).resolves.toBeTruthy();
    expect(reportParams()[0]).toBe(defaultDays);
  });

  it('measures against the per-system moment, never against now()', async () => {
    stage([]);
    await report.run({}, {});
    const sql = reportSql();
    expect(sql).toContain('WITH measurement AS');
    expect(sql).toContain('m."measuredAt" - make_interval');
    // The disappointment case in the issue: counting from today turns a missed
    // sync into a tenant-wide staleness alert.
    expect(sql).not.toContain('now() - make_interval');
  });

  it('passes the activity notices through with its rows', async () => {
    stage([], [{ systemName: 'Entra ID', measuredAt: null }]);
    const { notices } = await report.run({}, {});
    expect(notices[0].text).toMatch(/No sign-in activity has been collected yet/);
  });

  it('skips soft-deleted principals', async () => {
    stage([]);
    await report.run({}, {});
    expect(reportSql()).toContain('p."deletedAt" IS NULL');
  });
});

describe('stale-accounts', () => {
  const row = (over) => ({
    id: 'p1', displayName: 'Ingrid Larsen', email: 'ingrid@example.com',
    systemName: 'Entra ID', lastSignIn: '2026-05-19T09:00:00.000Z',
    measuredAt: MEASURED, assignmentCount: 4, ...over,
  });

  it('lists only enabled user accounts that still hold an assignment', async () => {
    stage([]);
    await staleAccounts.run({}, {});
    const sql = reportSql();
    expect(sql).toContain(`p."principalType" = 'User'`);
    expect(sql).toContain('p."accountEnabled" IS TRUE');
    // "Unused" alone is housekeeping; "unused AND still granting" is the finding.
    expect(sql).toContain('EXISTS (SELECT 1 FROM "ResourceAssignments" ra');
  });

  it('requires a sign-in to have happened — never-signed-in is a different report', async () => {
    stage([]);
    await staleAccounts.run({}, {});
    expect(reportSql()).toContain('act."lastSignIn" IS NOT NULL');
  });

  it('joins the measurement CTE, so a system with no activity drops out entirely', async () => {
    stage([]);
    await staleAccounts.run({}, {});
    // An INNER JOIN here is what stops "no data" turning into "everyone stale".
    expect(reportSql()).toMatch(/\n\s*JOIN measurement m ON m\."systemId" = p\."systemId"/);
  });

  it('counts days inactive from the measurement moment, not from today', async () => {
    stage([row({ lastSignIn: '2026-06-18T02:00:00.000Z' })]);
    const { rows } = await staleAccounts.run({}, {});
    // 2026-06-18 → 2026-09-16 is 90 days; today's date must not enter into it.
    expect(rows[0].daysInactive).toBe(90);
    expect(rows[0].measuredOn).toBe('2026-09-16');
    expect(rows[0].lastSignIn).toBe('2026-06-18');
  });

  it('links each row to the account detail tab', async () => {
    stage([row()]);
    const { rows } = await staleAccounts.run({}, {});
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'p1' });
    for (const col of staleAccounts.columns) expect(rows[0]).toHaveProperty(col.key);
  });

  it('logs the count and the threshold it used', async () => {
    stage([row()]);
    const log = vi.fn();
    await staleAccounts.run({ days: 45 }, { log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/1 account\(s\) idle for over 45 day\(s\)/));
  });

  it('runs without a logger', async () => {
    stage([]);
    await expect(staleAccounts.run({}, undefined)).resolves.toBeTruthy();
  });
});

describe('never-signed-in', () => {
  const row = (over) => ({
    id: 'p2', displayName: 'Zara Intern', email: 'zara@example.com',
    systemName: 'Entra ID', createdDateTime: '2026-07-17T00:00:00.000Z',
    measuredAt: MEASURED, assignmentCount: 1, ...over,
  });

  it('requires the absence of every sign-in timestamp', async () => {
    stage([]);
    await neverSignedIn.run({}, {});
    expect(reportSql()).toContain('act."lastSignIn" IS NULL');
  });

  it('ages the account against the measurement moment, not against today', async () => {
    stage([]);
    await neverSignedIn.run({}, {});
    // An account created after the last collection could not have been seen
    // signing in, so reporting it would be an artefact of the crawl schedule.
    expect(reportSql()).toContain('p."createdDateTime" < m."measuredAt" - make_interval(days => $1)');
  });

  it('skips an account with no creation date rather than guessing its age', async () => {
    stage([]);
    await neverSignedIn.run({}, {});
    expect(reportSql()).toContain('p."createdDateTime" IS NOT NULL');
  });

  it('reports days since created, measured to the collection moment', async () => {
    stage([row({ createdDateTime: '2026-08-17T02:00:00.000Z' })]);
    const { rows } = await neverSignedIn.run({}, {});
    expect(rows[0]).toMatchObject({ daysSinceCreated: 30, createdOn: '2026-08-17', measuredOn: '2026-09-16' });
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'p2' });
  });
});

describe('stale-guest-accounts', () => {
  const guest = (over) => ({
    id: 'g1', displayName: 'Marta Ferreira (Guest)', email: 'marta@partner.example',
    systemName: 'Entra ID', invitationState: 'Accepted',
    lastSignIn: '2026-01-19T00:00:00.000Z', measuredAt: MEASURED, ...over,
  });

  it('lists guests only — a member account is never in this report', async () => {
    stage([]);
    await staleGuests.run({}, {});
    expect(reportSql()).toContain(`p."extendedAttributes"->>'userType' = 'Guest'`);
  });

  it('binds the pending-invitation state rather than hardcoding it in the SQL text', async () => {
    stage([]);
    await staleGuests.run({}, {});
    expect(reportParams()).toEqual([30, 'PendingAcceptance']);
  });

  it('LEFT JOINs the measurement, so an unaccepted invitation is listed without activity data', async () => {
    stage([]);
    await staleGuests.run({}, {});
    const sql = reportSql();
    // "Never accepted" is not an activity question; requiring a measurement
    // would hide it in a tenant that collects no sign-in data.
    expect(sql).toContain('LEFT JOIN measurement m');
    expect(sql).toContain('m."measuredAt" IS NOT NULL');
  });

  it('gives a stale guest the staleness reason, with the threshold in words', async () => {
    stage([guest()]);
    const { rows } = await staleGuests.run({}, {});
    expect(rows[0].reason).toBe('No sign-in for over 30 days');
    expect(rows[0].daysInactive).toBe(240);
  });

  it('gives a never-accepted invitation its own reason, with no invented dates', async () => {
    stage([guest({ id: 'g2', invitationState: 'PendingAcceptance', lastSignIn: null })]);
    const { rows } = await staleGuests.run({}, {});
    expect(rows[0]).toMatchObject({
      reason: 'Invitation never accepted',
      lastSignIn: null,
      daysInactive: null,
      invitationState: 'PendingAcceptance',
    });
  });

  it('states both reasons when a guest is pending AND long idle', async () => {
    stage([guest({ invitationState: 'PendingAcceptance' })]);
    const { rows } = await staleGuests.run({}, {});
    expect(rows[0].reason).toBe('Invitation never accepted; No sign-in for over 30 days');
  });

  it('reflects a custom threshold in the reason text', async () => {
    stage([guest()]);
    const { rows } = await staleGuests.run({ days: 7 }, {});
    expect(rows[0].reason).toBe('No sign-in for over 7 days');
  });

  it('links each guest to the account detail tab', async () => {
    stage([guest()]);
    const { rows } = await staleGuests.run({}, {});
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'g1' });
  });
});
