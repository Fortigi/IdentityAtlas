// Unit tests for the scheduler's pure and near-pure functions.
//
// Full tick() behaviour (DB round-trip, timer firing) is covered by the
// Docker integration tests. Here we validate the deterministic pieces with
// mocked dependencies:
//   - scheduleMatches: hourly/daily/weekly rules, edge cases
//   - recentlyQueuedJobExists: 55-minute dedup query
//   - queueScheduledJob: allowlist check, validation, credential stripping

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── scheduleMatches — no deps, import directly ───────────────────────────

import { scheduleMatches, extractSchedules } from './scheduler.js';

// Fixed reference time: Wednesday 2026-06-17 14:30 UTC (day=3)
const REF = new Date('2026-06-17T14:30:00Z');

describe('extractSchedules', () => {
  it('returns the schedules array when present and non-empty', () => {
    const schedules = [{ minute: 0 }, { minute: 30 }];
    expect(extractSchedules({ schedules })).toBe(schedules);
  });
  it('wraps the legacy single schedule object in an array', () => {
    const schedule = { enabled: true, minute: 15 };
    expect(extractSchedules({ schedule })).toEqual([schedule]);
  });
  it('prefers schedules over a legacy schedule when both are present', () => {
    const schedules = [{ minute: 5 }];
    expect(extractSchedules({ schedules, schedule: { minute: 15 } })).toBe(schedules);
  });
  it('falls back to the legacy schedule when schedules is empty', () => {
    const schedule = { minute: 15 };
    expect(extractSchedules({ schedules: [], schedule })).toEqual([schedule]);
  });
  it('returns an empty array when neither is present', () => {
    expect(extractSchedules({})).toEqual([]);
  });
});

describe('scheduleMatches', () => {
  describe('disabled or malformed schedules', () => {
    it('returns false for null', () => expect(scheduleMatches(null, REF)).toBe(false));
    it('returns false when enabled is explicitly false', () => {
      expect(scheduleMatches({ enabled: false, frequency: 'hourly', minute: 30 }, REF)).toBe(false);
    });
    it('returns false when minute is missing', () => {
      expect(scheduleMatches({ frequency: 'hourly' }, REF)).toBe(false);
    });
    it('returns false when minute is out of range', () => {
      expect(scheduleMatches({ frequency: 'hourly', minute: 60 }, REF)).toBe(false);
      expect(scheduleMatches({ frequency: 'hourly', minute: -1 }, REF)).toBe(false);
    });
    it('returns false when minute is not a number', () => {
      expect(scheduleMatches({ frequency: 'hourly', minute: '30' }, REF)).toBe(false);
    });
  });

  describe('hourly', () => {
    it('fires when minute matches regardless of hour', () => {
      expect(scheduleMatches({ frequency: 'hourly', minute: 30 }, REF)).toBe(true);
    });
    it('does not fire when minute differs', () => {
      expect(scheduleMatches({ frequency: 'hourly', minute: 29 }, REF)).toBe(false);
      expect(scheduleMatches({ frequency: 'hourly', minute: 31 }, REF)).toBe(false);
    });
    it('fires at minute 0', () => {
      const top = new Date('2026-06-17T14:00:00Z');
      expect(scheduleMatches({ frequency: 'hourly', minute: 0 }, top)).toBe(true);
    });
  });

  describe('daily', () => {
    it('fires when hour and minute both match', () => {
      expect(scheduleMatches({ frequency: 'daily', hour: 14, minute: 30 }, REF)).toBe(true);
    });
    it('does not fire when only minute matches', () => {
      expect(scheduleMatches({ frequency: 'daily', hour: 15, minute: 30 }, REF)).toBe(false);
    });
    it('does not fire when only hour matches', () => {
      expect(scheduleMatches({ frequency: 'daily', hour: 14, minute: 29 }, REF)).toBe(false);
    });
    it('returns false when hour is missing', () => {
      expect(scheduleMatches({ frequency: 'daily', minute: 30 }, REF)).toBe(false);
    });
    it('defaults to daily when frequency is omitted', () => {
      expect(scheduleMatches({ hour: 14, minute: 30 }, REF)).toBe(true);
      expect(scheduleMatches({ hour: 14, minute: 29 }, REF)).toBe(false);
    });
  });

  describe('weekly', () => {
    it('fires on the right day, hour, and minute (Wednesday = day 3)', () => {
      expect(scheduleMatches({ frequency: 'weekly', day: 3, hour: 14, minute: 30 }, REF)).toBe(true);
    });
    it('does not fire on the wrong day', () => {
      expect(scheduleMatches({ frequency: 'weekly', day: 2, hour: 14, minute: 30 }, REF)).toBe(false);
    });
    it('does not fire when hour differs', () => {
      expect(scheduleMatches({ frequency: 'weekly', day: 3, hour: 13, minute: 30 }, REF)).toBe(false);
    });
    it('does not fire when minute differs', () => {
      expect(scheduleMatches({ frequency: 'weekly', day: 3, hour: 14, minute: 29 }, REF)).toBe(false);
    });
    it('returns false when day is missing', () => {
      expect(scheduleMatches({ frequency: 'weekly', hour: 14, minute: 30 }, REF)).toBe(false);
    });
    it('returns false when hour is missing', () => {
      expect(scheduleMatches({ frequency: 'weekly', day: 3, minute: 30 }, REF)).toBe(false);
    });
  });

  describe('interval', () => {
    const at = (hhmm) => new Date(`2026-06-17T${hhmm}:00Z`);
    it('fires on every multiple of the interval, counted from midnight', () => {
      const every10 = { frequency: 'interval', intervalMinutes: 10 };
      expect(scheduleMatches(every10, at('14:30'))).toBe(true);
      expect(scheduleMatches(every10, at('14:40'))).toBe(true);
      expect(scheduleMatches(every10, at('00:00'))).toBe(true);
      expect(scheduleMatches(every10, at('14:35'))).toBe(false);
    });
    it('needs no hour or minute', () => {
      expect(scheduleMatches({ frequency: 'interval', intervalMinutes: 15 }, at('14:45'))).toBe(true);
      expect(scheduleMatches({ frequency: 'interval', intervalMinutes: 15 }, at('14:50'))).toBe(false);
    });
    it('refuses an interval that does not divide the hour, or none at all', () => {
      // 7 would fire at 14:00 (840 % 7 = 0) if it were accepted.
      expect(scheduleMatches({ frequency: 'interval', intervalMinutes: 7 }, at('14:00'))).toBe(false);
      expect(scheduleMatches({ frequency: 'interval', intervalMinutes: '10' }, at('14:00'))).toBe(false);
      expect(scheduleMatches({ frequency: 'interval' }, at('14:00'))).toBe(false);
    });
    it('respects enabled: false', () => {
      expect(scheduleMatches({ enabled: false, frequency: 'interval', intervalMinutes: 5 }, at('14:30'))).toBe(false);
    });
  });

  it('returns false for an unknown frequency', () => {
    expect(scheduleMatches({ frequency: 'monthly', hour: 14, minute: 30 }, REF)).toBe(false);
  });
});

// ─── recentlyQueuedJobExists and queueScheduledJob — require mocked deps ──
//
// vi.doMock + vi.resetModules lets us inject a fake db per test group without
// the mock leaking across unrelated tests. Same pattern as engine.runLinking.test.js.

const VALID_TYPES = ['demo', 'csv', 'entra-id', 'omada'];

function makeDb({ recentJob = null, insertedId = 99 } = {}) {
  return {
    queryOne: vi.fn(async (sql) => {
      if (/FROM "CrawlerJobs"/.test(sql)) return recentJob;
      if (/INSERT INTO "CrawlerJobs"/.test(sql)) return { id: insertedId };
      return null; // UPDATE "CrawlerConfigs"
    }),
    query: vi.fn(async () => {}),
  };
}

async function loadScheduler(db, { validTypes = VALID_TYPES, validateResult = null } = {}) {
  vi.resetModules();
  vi.doMock('./db/connection.js', () => db);
  vi.doMock('./crawlerManifests.js', () => ({
    VALID_JOB_TYPES: validTypes,
    validateStoredCrawlerConfig: vi.fn(async () => validateResult),
  }));
  vi.doMock('./secrets/crawlerSecrets.js', () => ({
    storeJobCredentials: vi.fn(async () => {}),
    OTHER_SECRET_FIELDS: ['password', 'apiToken', 'cookieString'],
  }));
  vi.doMock('./riskscoring/engine.js', () => ({ runScoring: vi.fn(async () => {}) }));
  vi.doMock('./accountlinking/engine.js', () => ({ runLinking: vi.fn(async () => {}) }));
  vi.doMock('./routes/jobs.js', () => ({ VALID_JOB_TYPES: validTypes }));
  return import('./scheduler.js');
}

describe('recentlyQueuedJobExists', () => {
  beforeEach(() => vi.resetModules());

  it('returns false when no recent job exists', async () => {
    const db = makeDb({ recentJob: null });
    const { recentlyQueuedJobExists } = await loadScheduler(db);
    expect(await recentlyQueuedJobExists(1, 'csv')).toBe(false);
    expect(db.queryOne).toHaveBeenCalledOnce();
  });

  it('returns true when a recent job is found', async () => {
    const db = makeDb({ recentJob: { id: 5 } });
    const { recentlyQueuedJobExists } = await loadScheduler(db);
    expect(await recentlyQueuedJobExists(1, 'csv')).toBe(true);
  });

  it('looks only at jobs of the same schedule entry, within that entry\'s window', async () => {
    const db = makeDb();
    const { recentlyQueuedJobExists } = await loadScheduler(db);
    await recentlyQueuedJobExists(42, 'omada', 3, 9);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toMatch(/"CrawlerJobs"/);
    expect(sql).toContain('"configId" = $2');
    expect(sql).toContain("config->>'_scheduleIndex' = $3");
    expect(sql).toContain('$4::int * interval');
    expect(params).toEqual(['omada', 42, '3', 9]);
  });

  it('defaults to a 55-minute window', async () => {
    const db = makeDb();
    const { recentlyQueuedJobExists } = await loadScheduler(db);
    await recentlyQueuedJobExists(42, 'omada', 0);
    expect(db.queryOne.mock.calls[0][1]).toEqual(['omada', 42, '0', 55]);
  });
});

describe('guardWindowMinutes', () => {
  it('is just under the interval for an interval schedule', async () => {
    const { guardWindowMinutes } = await import('./scheduler.js');
    expect(guardWindowMinutes({ frequency: 'interval', intervalMinutes: 10 })).toBe(9);
    expect(guardWindowMinutes({ frequency: 'interval', intervalMinutes: 5 })).toBe(4);
  });
  it('is 55 minutes for every other frequency', async () => {
    const { guardWindowMinutes } = await import('./scheduler.js');
    expect(guardWindowMinutes({ frequency: 'hourly', minute: 0 })).toBe(55);
    expect(guardWindowMinutes({ frequency: 'daily', hour: 2, minute: 0 })).toBe(55);
    expect(guardWindowMinutes(undefined)).toBe(55);
  });
});

describe('scheduleFiringOrder', () => {
  it('puts full-sync entries first and keeps the order within each group', async () => {
    const { scheduleFiringOrder } = await import('./scheduler.js');
    const schedules = [
      { frequency: 'interval', intervalMinutes: 10, syncMode: 'delta' },
      { frequency: 'daily', hour: 3, minute: 0, syncMode: 'full' },
      { frequency: 'hourly', minute: 0 },
      { frequency: 'daily', hour: 12, minute: 0, syncMode: 'full' },
    ];
    expect(scheduleFiringOrder(schedules)).toEqual([1, 3, 0, 2]);
  });
});

describe('queueScheduledJob', () => {
  beforeEach(() => vi.resetModules());

  const baseConfig = {
    id: 7,
    crawlerType: 'csv',
    displayName: 'Test CSV',
    nextRunMode: null,
    config: {
      systemName: 'HR',
      csvFolder: '/data',
      schedules: [{ enabled: true, frequency: 'daily', hour: 6, minute: 0 }],
    },
  };

  it('skips and warns when crawlerType is not in VALID_JOB_TYPES', async () => {
    const db = makeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { queueScheduledJob } = await loadScheduler(db, { validTypes: ['demo'] });
    await queueScheduledJob(baseConfig, 0);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unsupported crawlerType/));
    warn.mockRestore();
  });

  it('skips and warns when validateStoredCrawlerConfig returns an error', async () => {
    const db = makeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { queueScheduledJob } = await loadScheduler(db, { validateResult: 'csvFolder is required' });
    await queueScheduledJob(baseConfig, 0);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid csv config/));
    warn.mockRestore();
  });

  // Helper: params arrive as (sql, paramsArray) — extract the stored JSON blob
  function storedJobConfig(db) {
    const call = db.queryOne.mock.calls.find(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));
    expect(call).toBeDefined();
    return JSON.parse(call[1][1]); // call[1] = paramsArray; [1] = second param = JSON string
  }

  it('inserts the job when config is valid', async () => {
    const db = makeDb({ insertedId: 55 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(baseConfig, 0);
    const stored = storedJobConfig(db);
    expect(stored._scheduledByConfigId).toBe(7);
    expect(stored._scheduleIndex).toBe(0);
    // jobType is the first param
    const call = db.queryOne.mock.calls.find(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));
    expect(call[1][0]).toBe('csv');
  });

  // SEC-2026-09 H-02: the scheduler writes the configId column itself and never
  // carries a _-prefixed key saved into the stored config.
  it('writes the source config id to the configId column and drops stored _ keys', async () => {
    const db = makeDb({ insertedId: 56 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob({ ...baseConfig, config: { ...baseConfig.config, _scheduledByConfigId: 3, _custom: 1 } }, 0);
    const call = db.queryOne.mock.calls.find(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));
    expect(call[0]).toContain('"configId"');
    expect(call[1][2]).toBe(7);
    const stored = storedJobConfig(db);
    expect(stored._scheduledByConfigId).toBe(7);
    expect(stored).not.toHaveProperty('_custom');
  });

  it('deletes clientSecret from the stored job config', async () => {
    const db = makeDb({ insertedId: 1 });
    const configWithSecret = {
      ...baseConfig,
      config: { ...baseConfig.config, clientSecret: 'should-be-stripped' },
    };
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(configWithSecret, 0);
    expect(storedJobConfig(db).clientSecret).toBeUndefined();
  });

  it('strips OTHER_SECRET_FIELDS and vaults them separately', async () => {
    const db = makeDb({ insertedId: 10 });
    const configWithCreds = {
      ...baseConfig,
      config: { ...baseConfig.config, password: 'p@ssw0rd', apiToken: 'tok' },
    };
    const { queueScheduledJob } = await loadScheduler(db);
    const { storeJobCredentials } = await import('./secrets/crawlerSecrets.js');
    await queueScheduledJob(configWithCreds, 0);
    const stored = storedJobConfig(db);
    expect(stored.password).toBeUndefined();
    expect(stored.apiToken).toBeUndefined();
    expect(storeJobCredentials).toHaveBeenCalledWith(10, expect.objectContaining({ password: 'p@ssw0rd', apiToken: 'tok' }));
  });

  it('defaults _syncMode to delta when not specified anywhere', async () => {
    const db = makeDb({ insertedId: 1 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(baseConfig, 0);
    expect(storedJobConfig(db)._syncMode).toBe('delta');
  });

  it('uses schedule-level syncMode when set', async () => {
    const db = makeDb({ insertedId: 1 });
    const configWithSyncMode = {
      ...baseConfig,
      config: {
        ...baseConfig.config,
        schedules: [{ enabled: true, frequency: 'daily', hour: 6, minute: 0, syncMode: 'full' }],
      },
    };
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(configWithSyncMode, 0);
    expect(storedJobConfig(db)._syncMode).toBe('full');
  });

  it('falls back to nextRunMode when schedule has no syncMode', async () => {
    const db = makeDb({ insertedId: 1 });
    const configWithNextRun = { ...baseConfig, nextRunMode: 'full' };
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(configWithNextRun, 0);
    expect(storedJobConfig(db)._syncMode).toBe('full');
  });

  // Both queue paths (Run Now and the scheduler) have to stamp the name, or a
  // crawler's system is named after its type on scheduled runs only.
  it('stamps the crawler name into the stored job config as _configName', async () => {
    const db = makeDb({ insertedId: 1 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(baseConfig, 0);
    expect(storedJobConfig(db)._configName).toBe('Test CSV');
  });

  it('omits _configName when the config row has no displayName', async () => {
    const db = makeDb({ insertedId: 1 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob({ ...baseConfig, displayName: null }, 0);
    expect(storedJobConfig(db)).not.toHaveProperty('_configName');
  });

  it('updates lastRunAt on the config after queuing', async () => {
    const db = makeDb({ insertedId: 1 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(baseConfig, 0);
    const updateCall = db.query.mock.calls.find(c => /UPDATE "CrawlerConfigs"/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain(7); // config id
  });
});

// ─── fireScheduleIfDue — one job per crawler configuration ─────────────────
//
// The field failure: a full load started at 12:18 was still running when the
// 6 am delta fired. recentlyQueuedJobExists only looks back 55 minutes, so the
// delta was queued beside it and both ran at once.
describe('fireScheduleIfDue — a configuration that is still busy', () => {
  beforeEach(() => vi.resetModules());

  const configRow = {
    id: 7, crawlerType: 'csv', displayName: 'SailPoint SQL', nextRunMode: null,
    config: { csvFolder: '/data', schedules: [{ enabled: true, frequency: 'daily', hour: 6, minute: 0 }] },
  };
  const SIX_AM = new Date('2026-09-30T06:00:00Z');

  // queryOne answers the 55-minute look-back (nothing recent) and the insert;
  // query answers the busy check and the lastRunAt update.
  function busyDb(activeRows) {
    return {
      queryOne: vi.fn(async (sql) => (/INSERT INTO "CrawlerJobs"/.test(sql) ? { id: 99 } : null)),
      query: vi.fn(async (sql) => ({ rows: /"configId" = \$1 AND status IN \('queued', 'running'\)/.test(sql) ? activeRows : [] })),
    };
  }
  const queued = (db) => db.queryOne.mock.calls.some(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));

  it('does not queue while an older job of the same configuration is still running, and says why', async () => {
    const db = busyDb([{ id: 12, status: 'running' }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    expect(queued(db)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/postponed config 7 \(SailPoint SQL\) — job 12 is still running/));
    log.mockRestore();
  });

  it('skips while one is only queued as well', async () => {
    const db = busyDb([{ id: 13, status: 'queued' }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    expect(queued(db)).toBe(false);
    log.mockRestore();
  });

  it('asks about this configuration, not about the crawler type', async () => {
    const db = busyDb([]);
    const { fireScheduleIfDue } = await loadScheduler(db);
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    const busyCall = db.query.mock.calls.find(c => /"configId" = \$1 AND status IN \('queued', 'running'\)/.test(c[0]));
    expect(busyCall[1]).toEqual([7]);
  });

  it('queues as before when the configuration is idle', async () => {
    const db = busyDb([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    expect(queued(db)).toBe(true);
    log.mockRestore();
  });

  it('does not ask again in the same minute once it has skipped', async () => {
    const db = busyDb([{ id: 12, status: 'running' }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    await fireScheduleIfDue(configRow, 0, configRow.config.schedules[0], SIX_AM, 'k1');
    expect(db.query.mock.calls.filter(c => /"configId" = \$1 AND status IN \('queued', 'running'\)/.test(c[0]))).toHaveLength(1);
    log.mockRestore();
  });
});

// ─── A full that lands on a busy config is retried, not lost ───────────────
//
// With a delta every five minutes, the daily full at 03:00 often finds a delta
// still running. Skipping it there would lose it for the whole day.
describe('fireScheduleIfDue — retrying an occurrence that found the config busy', () => {
  beforeEach(() => vi.resetModules());

  const full = { enabled: true, frequency: 'daily', hour: 3, minute: 0, syncMode: 'full' };
  const delta = { enabled: true, frequency: 'interval', intervalMinutes: 5, syncMode: 'delta' };
  const configRow = { id: 8, crawlerType: 'entra-id', displayName: 'Tenant', nextRunMode: null, config: { schedules: [delta, full] } };
  const at = (hhmm) => new Date(`2026-10-20T${hhmm}:00Z`);

  // A db whose busy answer is switched per call by the test.
  function switchableDb() {
    const state = { busy: true };
    const db = {
      queryOne: vi.fn(async (sql) => (/INSERT INTO "CrawlerJobs"/.test(sql) ? { id: 99 } : null)),
      query: vi.fn(async (sql) => ({
        rows: /status IN \('queued', 'running'\)/.test(sql) && state.busy ? [{ id: 50, status: 'running' }] : [],
      })),
    };
    return { db, state };
  }
  const inserts = (db) => db.queryOne.mock.calls.filter(c => /INSERT INTO "CrawlerJobs"/.test(c[0]));

  it('queues the full on a later tick once the delta has finished', async () => {
    const { db, state } = switchableDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);

    await fireScheduleIfDue(configRow, 1, full, at('03:00'), 'm0');   // busy → postponed
    expect(inserts(db)).toHaveLength(0);
    await fireScheduleIfDue(configRow, 1, full, at('03:01'), 'm1');   // still busy
    expect(inserts(db)).toHaveLength(0);
    state.busy = false;
    await fireScheduleIfDue(configRow, 1, full, at('03:02'), 'm2');   // not due by the clock, but pending
    expect(inserts(db)).toHaveLength(1);
    expect(JSON.parse(inserts(db)[0][1][1])._syncMode).toBe('full');

    // Queued once — not again on the tick after.
    await fireScheduleIfDue(configRow, 1, full, at('03:03'), 'm3');
    expect(inserts(db)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/postponed config 8 \(Tenant\) — job 50 is still running/));
    log.mockRestore();
  });

  it('skips a busy interval occurrence instead of retrying it', async () => {
    const { db, state } = switchableDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);

    await fireScheduleIfDue(configRow, 0, delta, at('03:05'), 'm0');
    state.busy = false;
    await fireScheduleIfDue(configRow, 0, delta, at('03:06'), 'm1');   // not due, nothing pending
    expect(inserts(db)).toHaveLength(0);
    await fireScheduleIfDue(configRow, 0, delta, at('03:10'), 'm2');   // next occurrence
    expect(inserts(db)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped config 8/));
    log.mockRestore();
  });

  it('gives up after an hour and stops retrying', async () => {
    const { db, state } = switchableDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue, pruneSchedulerState } = await loadScheduler(db);

    await fireScheduleIfDue(configRow, 1, full, at('03:00'), 'm0');
    pruneSchedulerState('m59', at('03:59'));        // within the hour: kept
    pruneSchedulerState('m61', at('04:01'));        // past it: dropped
    state.busy = false;
    await fireScheduleIfDue(configRow, 1, full, at('04:02'), 'm62');
    expect(inserts(db)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/gave up on crawler:8:1/));
    log.mockRestore();
  });

  it('does not run the cross-restart look-back for a retry', async () => {
    const { db, state } = switchableDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fireScheduleIfDue } = await loadScheduler(db);

    await fireScheduleIfDue(configRow, 1, full, at('03:00'), 'm0');
    const lookBacks = () => db.queryOne.mock.calls.filter(c => /_scheduleIndex/.test(c[0])).length;
    expect(lookBacks()).toBe(1);
    state.busy = false;
    await fireScheduleIfDue(configRow, 1, full, at('03:01'), 'm1');
    expect(lookBacks()).toBe(1);
    expect(inserts(db)).toHaveLength(1);
    log.mockRestore();
  });
});
