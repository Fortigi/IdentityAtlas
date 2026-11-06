// Change requests — the pure parts of the context page's panel
// (docs/architecture/change-requests.md).

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

/** The open requests, and the closed ones (resolved / withdrawn), each in the API's order. Pure. */
export function splitRequests(items = []) {
  const open = [];
  const closed = [];
  for (const r of items) (r.status === 'open' ? open : closed).push(r);
  return { open, closed };
}

/** "Klanten (upload) · raised by wim@example.org on 2026-10-23". Pure. */
export function raisedLine(r) {
  const who = r.raisedBy && r.raisedBy !== 'unknown' ? ` by ${r.raisedBy}` : '';
  return `${r.targetName} · raised${who} on ${day(r.raisedAt)}`;
}

const CLOSED_LABEL = { resolved: 'Resolved', withdrawn: 'Withdrawn' };

/** "Resolved 2026-10-24: The source no longer lists them". Pure. */
export function closedLine(r) {
  const label = CLOSED_LABEL[r.status] ?? r.status;
  const reason = r.closedReason ? `: ${r.closedReason}` : '';
  return `${label} ${day(r.closedAt)}${reason}`;
}

/** The header count: "1 open" / "3 open · 2 closed" / "2 closed". Pure. */
export function countLabel({ open, closed }) {
  const parts = [];
  if (open.length) parts.push(`${open.length} open`);
  if (closed.length) parts.push(`${closed.length} closed`);
  return parts.join(' · ');
}
