// When a review campaign asks (migration 121). Pure: dates in, dates out.
//
// A campaign starts on a day and either asks once or again every so many
// months. Each time it asks is a round; a round is due a number of days after it
// starts. All dates are whole days in UTC ('YYYY-MM-DD'): a campaign is planned
// by the calendar, not by the hour.

export const INTERVALS = Object.freeze([1, 3, 6, 12]);
export const MIN_DUE_DAYS = 1;
export const MAX_DUE_DAYS = 365;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** [year, month 1-12, day] of a 'YYYY-MM-DD' that is a real day, else null. */
export function parseDay(text) {
  const m = DAY.exec(String(text ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return [y, mo, d];
}

const pad = (n) => String(n).padStart(2, '0');
const lastDayOf = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** The day `months` later, on the same day of the month or its last day (31 Jan + 1 → 28 Feb). */
export function addMonths(day, months) {
  const [y, mo, d] = parseDay(day);
  const index = (mo - 1) + months;
  const year = y + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDayOf(year, month)))}`;
}

/** The day `days` later. */
export function addDays(day, days) {
  const [y, mo, d] = parseDay(day);
  return new Date(Date.UTC(y, mo - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC day of a moment. */
export const dayOf = (moment) => new Date(moment).toISOString().slice(0, 10);

/**
 * The round a campaign should be in on `today`: { number, startsOn, dueOn }, or
 * null before its first day. A campaign that asks once has round 1 for good; a
 * repeating one is in the latest round whose start is not after today.
 */
export function roundOn({ startsOn, intervalMonths, dueDays }, today) {
  if (today < startsOn) return null;
  let number = 1;
  let start = startsOn;
  if (intervalMonths) {
    // Each round is counted from the first day, never from the previous round,
    // so a clamped month end (31 Jan → 28 Feb) does not drift to the 28th.
    for (let next = addMonths(startsOn, intervalMonths); next <= today; next = addMonths(startsOn, number * intervalMonths)) {
      number += 1;
      start = next;
    }
  }
  return { number, startsOn: start, dueOn: addDays(start, dueDays) };
}

/** The first day of the round after `number`, or null for a campaign that asks once. */
export function nextRoundOn({ startsOn, intervalMonths }, number) {
  return intervalMonths ? addMonths(startsOn, number * intervalMonths) : null;
}
