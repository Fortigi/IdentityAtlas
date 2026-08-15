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

  it('passes jobType and configId to the query', async () => {
    const db = makeDb();
    const { recentlyQueuedJobExists } = await loadScheduler(db);
    await recentlyQueuedJobExists(42, 'omada');
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toMatch(/"CrawlerJobs"/);
    expect(params).toContain('omada');
    expect(params).toContain(42);
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

  it('updates lastRunAt on the config after queuing', async () => {
    const db = makeDb({ insertedId: 1 });
    const { queueScheduledJob } = await loadScheduler(db);
    await queueScheduledJob(baseConfig, 0);
    const updateCall = db.query.mock.calls.find(c => /UPDATE "CrawlerConfigs"/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain(7); // config id
  });
});
