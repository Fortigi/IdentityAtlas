import { describe, it, expect } from 'vitest';
import { INTERVALS, parseDay, addMonths, addDays, dayOf, roundOn, nextRoundOn } from './reviewCampaignSchedule.js';

describe('parseDay', () => {
  it('reads a real day', () => {
    expect(parseDay('2026-11-27')).toEqual([2026, 11, 27]);
    expect(parseDay('2028-02-29')).toEqual([2028, 2, 29]);
  });

  it('refuses a day that does not exist and anything that is not a day', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-11-00', '27-11-2026', '2026-11-27T10:00:00Z', '', null, undefined, 20261127]) {
      expect(parseDay(bad)).toBeNull();
    }
  });
});

describe('addMonths', () => {
  it('keeps the day of the month, across a year end', () => {
    expect(addMonths('2026-11-27', 1)).toBe('2026-12-27');
    expect(addMonths('2026-11-27', 3)).toBe('2027-02-27');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-05-09', 0)).toBe('2026-05-09');
  });

  it('falls back to the last day of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
  });
});

describe('addDays and dayOf', () => {
  it('counts days across a month and a year end', () => {
    expect(addDays('2026-11-27', 14)).toBe('2026-12-11');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', 0)).toBe('2026-03-01');
  });

  it('takes the UTC day of a moment', () => {
    expect(dayOf('2026-11-27T23:59:59Z')).toBe('2026-11-27');
    expect(dayOf(new Date('2026-11-28T00:00:00Z'))).toBe('2026-11-28');
  });
});

describe('roundOn', () => {
  const once = { startsOn: '2026-12-01', intervalMonths: null, dueDays: 14 };
  const quarterly = { startsOn: '2026-12-01', intervalMonths: 3, dueDays: 30 };

  it('has no round before the first day, and round 1 on it', () => {
    expect(roundOn(once, '2026-11-30')).toBeNull();
    expect(roundOn(once, '2026-12-01')).toEqual({ number: 1, startsOn: '2026-12-01', dueOn: '2026-12-15' });
    expect(roundOn(quarterly, '2026-11-30')).toBeNull();
  });

  it('keeps a campaign that asks once in round 1 however long ago it was', () => {
    expect(roundOn(once, '2030-06-01')).toEqual({ number: 1, startsOn: '2026-12-01', dueOn: '2026-12-15' });
  });

  it('moves a repeating campaign to the next round on its first day, not a day earlier', () => {
    expect(roundOn(quarterly, '2027-02-28')).toEqual({ number: 1, startsOn: '2026-12-01', dueOn: '2026-12-31' });
    expect(roundOn(quarterly, '2027-03-01')).toEqual({ number: 2, startsOn: '2027-03-01', dueOn: '2027-03-31' });
    expect(roundOn(quarterly, '2027-12-15')).toEqual({ number: 5, startsOn: '2027-12-01', dueOn: '2027-12-31' });
  });

  it('counts every round from the first day, so a month end does not drift', () => {
    const monthly = { startsOn: '2026-01-31', intervalMonths: 1, dueDays: 7 };
    expect(roundOn(monthly, '2026-02-28')).toMatchObject({ number: 2, startsOn: '2026-02-28' });
    expect(roundOn(monthly, '2026-03-30')).toMatchObject({ number: 2, startsOn: '2026-02-28' });
    expect(roundOn(monthly, '2026-03-31')).toMatchObject({ number: 3, startsOn: '2026-03-31', dueOn: '2026-04-07' });
  });
});

describe('nextRoundOn', () => {
  it('is the first day of the round after this one, counted from the first day', () => {
    expect(nextRoundOn({ startsOn: '2026-12-01', intervalMonths: 3 }, 1)).toBe('2027-03-01');
    expect(nextRoundOn({ startsOn: '2026-01-31', intervalMonths: 1 }, 2)).toBe('2026-03-31');
  });

  it('is null for a campaign that asks once', () => {
    expect(nextRoundOn({ startsOn: '2026-12-01', intervalMonths: null }, 1)).toBeNull();
  });
});

describe('the intervals', () => {
  it('are monthly, quarterly, half-yearly and yearly', () => {
    expect(INTERVALS).toEqual([1, 3, 6, 12]);
  });
});
