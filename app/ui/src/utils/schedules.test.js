import { describe, it, expect } from 'vitest';
import { INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES, withFrequency, formatSchedule } from './schedules';

describe('withFrequency', () => {
  it('gives a schedule switched to an interval the default interval', () => {
    expect(withFrequency({ frequency: 'daily', hour: 2, minute: 0, syncMode: 'delta' }, 'interval'))
      .toEqual({ frequency: 'interval', hour: 2, minute: 0, syncMode: 'delta', intervalMinutes: DEFAULT_INTERVAL_MINUTES });
  });

  it('keeps a valid interval it already has', () => {
    expect(withFrequency({ frequency: 'hourly', intervalMinutes: 5 }, 'interval').intervalMinutes).toBe(5);
  });

  it('replaces an interval the scheduler would refuse', () => {
    expect(withFrequency({ intervalMinutes: 7 }, 'interval').intervalMinutes).toBe(15);
  });

  it('only changes the frequency for the other choices', () => {
    expect(withFrequency({ frequency: 'interval', intervalMinutes: 10 }, 'hourly'))
      .toEqual({ frequency: 'hourly', intervalMinutes: 10 });
  });

  it('offers only divisors of an hour', () => {
    for (const m of INTERVAL_MINUTES) expect(60 % m).toBe(0);
  });
});

describe('formatSchedule', () => {
  it('describes each frequency', () => {
    expect(formatSchedule({ frequency: 'interval', intervalMinutes: 10, syncMode: 'delta' })).toBe('every 10 min · delta');
    expect(formatSchedule({ frequency: 'hourly', minute: 15 })).toBe('hourly :15 · delta');
    expect(formatSchedule({ frequency: 'daily', hour: 2, minute: 0, syncMode: 'full' })).toBe('daily at 02:00 UTC · full');
    expect(formatSchedule({ frequency: 'weekly', day: 0, hour: 23, minute: 45, syncMode: 'full' })).toBe('weekly at 23:45 UTC on Sun · full');
  });

  it('reads a schedule without a frequency as daily, the way the scheduler does', () => {
    expect(formatSchedule({ hour: 6, minute: 30 })).toBe('daily at 06:30 UTC · delta');
  });
});
