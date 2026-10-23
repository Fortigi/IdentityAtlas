// Crawler schedule helpers shared by the schedule editor and the crawler card.

// The intervals an "every few minutes" schedule may use. Divisors of 60, so each
// run lands on the same minutes every hour. Mirrors INTERVAL_MINUTES in
// app/api/src/scheduler.js, which refuses any other value.
export const INTERVAL_MINUTES = [5, 10, 15, 20, 30];
export const DEFAULT_INTERVAL_MINUTES = 15;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n ?? 0).padStart(2, '0');

// The schedule with its frequency changed. Switching to an interval gives it a
// valid interval when it has none, so the saved schedule always fires. Pure.
export function withFrequency(schedule, frequency) {
  const next = { ...schedule, frequency };
  if (frequency === 'interval' && !INTERVAL_MINUTES.includes(next.intervalMinutes)) {
    next.intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  }
  return next;
}

// One-line label for a schedule, e.g. "every 15 min · delta" or
// "daily at 02:00 UTC · full". Pure.
export function formatSchedule(s) {
  const mode = s.syncMode === 'full' ? 'full' : 'delta';
  const frequency = s.frequency || 'daily';
  if (frequency === 'interval') return `every ${s.intervalMinutes} min · ${mode}`;
  if (frequency === 'hourly') return `hourly :${pad(s.minute)} · ${mode}`;
  const day = frequency === 'weekly' ? ` on ${DAYS[s.day ?? 0]}` : '';
  return `${frequency} at ${pad(s.hour)}:${pad(s.minute)} UTC${day} · ${mode}`;
}
