// ─── Review campaigns: the words and the sums ────────────────────────────
// Pure helpers for the campaign screens (the Reviews tab) and for the
// notice an asked person gets. The data is /api/review-campaigns and
// /api/review-requests/mine (lib/reviewCampaigns.js).

export const INTERVALS = [
  { months: 1, label: 'Every month' },
  { months: 3, label: 'Every quarter' },
  { months: 6, label: 'Every half year' },
  { months: 12, label: 'Every year' },
];
export const DEFAULT_DUE_DAYS = 30;
export const ALL_STEPS = ['ownership', 'lifecycle', 'contents', 'improvements'];

export const STATUS_INFO = {
  noFindings: { label: 'Reviewed, no findings', tone: 'green' },
  findings: { label: 'Reviewed, with findings', tone: 'amber' },
  waiting: { label: 'Waiting', tone: 'gray' },
  overdue: { label: 'Late', tone: 'red' },
  noAccountable: { label: 'Nobody to ask', tone: 'red' },
};
export const CAMPAIGN_STATUS = { planned: 'Planned', running: 'Running', ended: 'Ended' };

const lower = (v) => String(v ?? '').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Today as YYYY-MM-DD, in UTC like the API plans by. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** "Once" or the interval's label. */
export function repeatText(intervalMonths) {
  if (!intervalMonths) return 'Once';
  return INTERVALS.find(i => i.months === intervalMonths)?.label ?? `Every ${intervalMonths} months`;
}

/** What a campaign is about, in a few words: "2 role portfolios, 3 business roles". */
export function scopeText({ portfolioCount = 0, roleCount = 0 }) {
  const parts = [
    portfolioCount > 0 && plural(portfolioCount, 'role portfolio', 'role portfolios'),
    roleCount > 0 && plural(roleCount, 'business role', 'business roles'),
  ].filter(Boolean);
  return parts.join(', ') || 'Nothing';
}

/** How a round stands: "3 of 5 reviewed". Roles nobody can be asked about do not count. */
export function progressText(round) {
  if (!round) return 'Not started';
  const asked = round.total - round.noAccountable;
  return `${round.reviewed} of ${asked} reviewed`;
}

/**
 * The form before anything is filled in: every step, nothing in scope, asking
 * once from today with the default term.
 */
export function emptyForm(now = new Date()) {
  return { name: '', steps: [...ALL_STEPS], portfolioIds: [], roleIds: [], repeat: false, intervalMonths: 12, startsOn: today(now), dueDays: DEFAULT_DUE_DAYS };
}

/** A list with `value` added when missing, removed when present. */
export function toggled(list, value) {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

/**
 * The roles a campaign would ask about now: those picked by themselves and
 * those in a picked portfolio, each once, with how many have nobody Accountable.
 */
export function rolesInScope(form, options) {
  const portfolios = new Set(form.portfolioIds.map(lower));
  const picked = new Set(form.roleIds.map(lower));
  const roles = (options?.roles ?? []).filter(r => picked.has(lower(r.id)) || (r.portfolioId && portfolios.has(lower(r.portfolioId))));
  return { roles, withoutAccountable: roles.filter(r => !r.hasAccountable) };
}

/** Why the form cannot be saved yet, or null. */
export function formProblem(form) {
  if (form.name.trim() === '') return 'Give the campaign a name';
  if (form.steps.length === 0) return 'Choose at least one step to review';
  if (form.portfolioIds.length + form.roleIds.length === 0) return 'Choose at least one business role or role portfolio';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startsOn)) return 'Choose the day the campaign starts';
  const days = Number(form.dueDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) return 'Give people between 1 and 365 days to review';
  return null;
}

/** What the form sends. */
export function formBody(form) {
  return {
    name: form.name.trim(),
    steps: ALL_STEPS.filter(s => form.steps.includes(s)),
    portfolioIds: form.portfolioIds,
    roleIds: form.roleIds,
    startsOn: form.startsOn,
    intervalMonths: form.repeat ? form.intervalMonths : null,
    dueDays: Number(form.dueDays),
  };
}

/** The roles to choose from whose name or portfolio contains the search text. */
export function filterRoles(roles, search) {
  const term = lower(search).trim();
  if (!term) return roles;
  return roles.filter(r => lower(r.displayName).includes(term) || lower(r.portfolioName).includes(term));
}

/** The requests of a round, split: who can be asked, and the roles that fall outside. */
export function splitRequests(requests = []) {
  return {
    asked: requests.filter(r => r.status !== 'noAccountable'),
    outside: requests.filter(r => r.status === 'noAccountable'),
  };
}

/**
 * What an asked person reads first: how many reviews wait, and the soonest
 * date — or that some are late. `requests` come soonest due first.
 */
export function requestsHeadline(requests) {
  const n = requests.length;
  const late = requests.filter(r => r.overdue).length;
  const what = n === 1 ? '1 business role is waiting for your review' : `${n} business roles are waiting for your review`;
  return { what, late, firstDue: requests[0]?.dueAt ?? null };
}

/** One role per request list entry: a role asked by two campaigns shows once, with the soonest. */
export function requestsByRole(requests) {
  const seen = new Map();
  for (const r of requests) if (!seen.has(lower(r.roleId))) seen.set(lower(r.roleId), r);
  return [...seen.values()];
}
