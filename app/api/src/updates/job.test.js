// Unit tests for updates/job.js — the daily update-check scheduler. runUpdateCheck
// is mocked and timers are faked. (#666: 0 floor.)

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./checkForUpdates.js', () => ({ runUpdateCheck: vi.fn() }));
import { runUpdateCheck } from './checkForUpdates.js';
import { startUpdateCheckJob } from './job.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('startUpdateCheckJob', () => {
  it('runs after the warm-up delay, then once a day', async () => {
    vi.useFakeTimers();
    runUpdateCheck.mockResolvedValue({});
    startUpdateCheckJob();
    expect(runUpdateCheck).not.toHaveBeenCalled();          // nothing before the delay
    await vi.advanceTimersByTimeAsync(90 * 1000);           // warm-up
    expect(runUpdateCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // one day
    expect(runUpdateCheck).toHaveBeenCalledTimes(2);
    expect(runUpdateCheck).toHaveBeenCalledWith({ source: 'scheduler' });
  });

  it('logs and swallows a failed check', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runUpdateCheck.mockRejectedValue(new Error('boom'));
    startUpdateCheckJob();
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Daily update check failed'), 'boom');
    errSpy.mockRestore();
  });
});
