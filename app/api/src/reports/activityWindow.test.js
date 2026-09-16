// The measurement moment and the notices built on it.
//
// These are the tests that pin the feature's central claim: staleness is
// counted from when the data was COLLECTED, not from today, and a system with
// no collected activity is stated rather than reported as entirely stale.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  MEASUREMENT_WARNING_DAYS, activityNotices, daysBetween, fetchMeasurementMoments,
  enabledUserActivityRow, enabledUserActivitySql, measurementCte, parseDays, daysParameterSchema,
} from './activityWindow.js';

const at = (iso) => new Date(iso);
const NOW = at('2026-09-16T12:00:00.000Z');

beforeEach(() => { query.mockReset(); });

describe('measurementCte', () => {
  const sql = measurementCte();

  it('takes the LATEST ingest moment per system', () => {
    expect(sql).toContain('MAX(pa."updatedAt") AS "measuredAt"');
    expect(sql).toContain('GROUP BY p."systemId"');
  });

  it('derives the moment from the data, not from crawler job history', () => {
    // Reading CrawlerJobs would couple every report to the job subsystem and
    // break for any principal ingested outside a job.
    expect(sql).toContain('"PrincipalActivity"');
    expect(sql).not.toMatch(/CrawlerJobs|GraphSyncLog/);
  });

  it('counts only aggregate rows — a per-app row is not a measurement of the account', () => {
    expect(sql).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
    expect(sql).toContain("IN ('SignIn', 'ServicePrincipalSignIn')");
    expect(sql).not.toContain('SignInPerApp');
  });

  it('binds nothing, so a caller keeps its own $n numbering', () => {
    expect(sql).not.toMatch(/\$\d/);
  });
});

describe('fetchMeasurementMoments', () => {
  it('lists every system that holds principals, measured or not', async () => {
    query.mockResolvedValue({ rows: [
      { systemName: 'Entra ID', measuredAt: '2026-09-15T02:00:00.000Z' },
      { systemName: 'SAP ERP', measuredAt: null },
    ] });

    expect(await fetchMeasurementMoments()).toEqual([
      { systemName: 'Entra ID', measuredAt: at('2026-09-15T02:00:00.000Z') },
      { systemName: 'SAP ERP', measuredAt: null },
    ]);
  });

  it('asks only about systems that actually hold live principals', async () => {
    query.mockResolvedValue({ rows: [] });
    await fetchMeasurementMoments();
    const sql = String(query.mock.calls[0][0]);
    // A system with no principals has nothing to be stale, so naming it in a
    // "no activity data" notice would be noise.
    expect(sql).toContain('EXISTS (SELECT 1 FROM "Principals" p');
    expect(sql).toContain('p."deletedAt" IS NULL');
  });
});

describe('daysBetween', () => {
  it('floors to whole days', () => {
    expect(daysBetween(at('2026-09-01T00:00:00Z'), at('2026-09-03T23:59:00Z'))).toBe(2);
  });

  it('never goes negative — a timestamp after the measurement is 0 days old', () => {
    expect(daysBetween(at('2026-09-10T00:00:00Z'), at('2026-09-01T00:00:00Z'))).toBe(0);
  });
});

describe('activityNotices', () => {
  it('states the measurement moment per system, and that later sign-ins are excluded', () => {
    const notices = activityNotices(
      [{ systemName: 'Entra ID', measuredAt: at('2026-09-16T02:00:00Z') }], NOW);

    expect(notices[0]).toEqual({
      severity: 'info',
      text: 'Based on activity data measured on 2026-09-16 (Entra ID). '
        + 'Sign-ins after that moment are not included.',
    });
  });

  it('names every measured system in the header', () => {
    const [header] = activityNotices([
      { systemName: 'Entra ID', measuredAt: at('2026-09-16T02:00:00Z') },
      { systemName: 'Omada', measuredAt: at('2026-09-15T02:00:00Z') },
    ], NOW);
    expect(header.text).toContain('2026-09-16 (Entra ID)');
    expect(header.text).toContain('2026-09-15 (Omada)');
  });

  it('warns, naming the system and the age, once the data is over two days old', () => {
    const notices = activityNotices(
      [{ systemName: 'Entra ID', measuredAt: at('2026-09-11T12:00:00Z') }], NOW);

    expect(notices).toContainEqual({
      severity: 'warning',
      text: 'Activity data is 5 days old — run a full sync of Entra ID.',
    });
  });

  it('stays quiet at exactly the threshold and speaks one day past it', () => {
    const atAge = days => activityNotices(
      [{ systemName: 'S', measuredAt: new Date(NOW.getTime() - days * 86400000) }], NOW);

    expect(atAge(MEASUREMENT_WARNING_DAYS).some(n => n.severity === 'warning')).toBe(false);
    expect(atAge(MEASUREMENT_WARNING_DAYS + 1).some(n => n.severity === 'warning')).toBe(true);
  });

  it('warns per system, so one stale crawler does not implicate the others', () => {
    const notices = activityNotices([
      { systemName: 'Fresh', measuredAt: at('2026-09-16T00:00:00Z') },
      { systemName: 'Stale', measuredAt: at('2026-08-16T00:00:00Z') },
    ], NOW);

    const warnings = notices.filter(n => n.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain('Stale');
    expect(warnings[0].text).not.toContain('Fresh');
  });

  it('says which systems were left out for having no activity at all', () => {
    const notices = activityNotices([
      { systemName: 'Entra ID', measuredAt: NOW },
      { systemName: 'SAP ERP', measuredAt: null },
      { systemName: 'Omada', measuredAt: null },
    ], NOW);

    expect(notices).toContainEqual({
      severity: 'info',
      text: 'No activity data for SAP ERP, Omada — accounts in those systems are not listed.',
    });
  });

  it('with NOTHING measured anywhere, says so instead of implying a clean result', () => {
    // The disappointment case: an empty PrincipalActivity must not read as
    // "no account is stale". This is the only notice, and it is a warning.
    const notices = activityNotices([{ systemName: 'Entra ID', measuredAt: null }], NOW);

    expect(notices).toHaveLength(1);
    expect(notices[0].severity).toBe('warning');
    expect(notices[0].text).toMatch(/No sign-in activity has been collected yet/);
    expect(notices[0].text).not.toMatch(/measured on/);
  });

  it('says the same for a deployment with no systems at all', () => {
    expect(activityNotices([], NOW)).toHaveLength(1);
  });

  it('defaults its clock to now, so a caller need not pass one', () => {
    const notices = activityNotices([{ systemName: 'S', measuredAt: new Date() }]);
    expect(notices.some(n => n.severity === 'warning')).toBe(false);
  });
});

describe('parseDays', () => {
  it('accepts a positive whole number, however it arrived', () => {
    expect(parseDays(45, 90)).toBe(45);
    expect(parseDays('45', 90)).toBe(45);   // query params are strings
  });

  it.each([
    ['absent', undefined], ['blank', ''], ['text', 'ninety'], ['zero', 0],
    ['negative', -5], ['fractional', 1.5], ['absurd', 400000], ['null', null],
    ['an array', ['1', '2']],
  ])('falls back to the declared default for %s rather than 500ing', (_label, value) => {
    expect(parseDays(value, 90)).toBe(90);
  });
});

describe('daysParameterSchema', () => {
  it('declares one optional integer with the template’s default and its own help text', () => {
    const schema = daysParameterSchema(30, 'How long.');
    expect(schema).toEqual({
      type: 'object',
      required: [],
      properties: {
        days: { type: 'integer', title: 'Days', description: 'How long.', default: 30 },
      },
    });
  });
});

describe('enabledUserActivitySql', () => {
  const finding = { condition: 'act."lastSignIn" IS NULL', orderBy: 'p."displayName"' };

  it('scopes to enabled, live user accounts before the finding', () => {
    const sql = enabledUserActivitySql(finding);
    expect(sql).toContain('p."deletedAt" IS NULL');
    expect(sql).toContain(`p."principalType" = 'User'`);
    expect(sql).toMatch(/p\."accountEnabled" IS TRUE\s+AND act\."lastSignIn" IS NULL\s+ORDER BY p\."displayName"$/);
  });

  it('inner-joins the measurement, so a system with no activity data drops out', () => {
    expect(enabledUserActivitySql(finding)).toMatch(/\n\s*JOIN measurement m ON m\."systemId" = p\."systemId"/);
    expect(enabledUserActivitySql(finding)).not.toContain('LEFT JOIN measurement');
  });

  it('selects extra columns only when a report asks for them', () => {
    expect(enabledUserActivitySql(finding)).toMatch(/p\.email,\s+s\."displayName" AS "systemName"/);
    expect(enabledUserActivitySql({ ...finding, columns: 'p."createdDateTime"' }))
      .toMatch(/p\.email,\s+p\."createdDateTime",\s+s\."displayName" AS "systemName"/);
  });
});

describe('enabledUserActivityRow', () => {
  it('maps the shared fields, dates the measurement and links the account', () => {
    expect(enabledUserActivityRow({
      id: 'u1', displayName: 'Ann', email: 'ann@x', systemName: 'Entra',
      assignmentCount: 3, measuredAt: at('2026-09-15T23:30:00.000Z'), lastSignIn: 'ignored',
    })).toEqual({
      displayName: 'Ann', email: 'ann@x', systemName: 'Entra', assignmentCount: 3,
      measuredOn: '2026-09-15', _entity: { kind: 'user', id: 'u1' },
    });
  });
});
