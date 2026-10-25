// Send survey and Do survey — the pure part (SendSurveyModal / SendSurveyCard / DoSurveyModal / DoSurveyCard).

/** The body POST /api/contexts/:id/surveys expects, from the form's state. */
export function sendBody({ templateId, to, person, includeSubContexts, dueAt, message }) {
  return {
    templateId,
    ...(to === 'person' && person ? { recipient: { principalId: person.id } } : { toAccountable: true }),
    includeSubContexts: !!includeSubContexts,
    ...(dueAt ? { dueAt } : {}),
    ...(message?.trim() ? { message: message.trim() } : {}),
  };
}

/** One line saying what was sent and what was skipped. */
export function sentSummary({ sent = [], skipped = [] }) {
  const s = sent.length === 1 ? `Sent to ${sent[0].recipientName}.` : `Sent ${sent.length} surveys.`;
  if (!skipped.length) return s;
  const names = skipped.slice(0, 3).map(x => x.contextName).join(', ');
  return `${s} Skipped ${skipped.length} without an Accountable: ${names}${skipped.length > 3 ? ', …' : ''}.`;
}

// ─── Do survey (DoSurveyModal / DoSurveyCard) ────────────────────────────

/** The body POST /api/contexts/:id/surveys/start expects: the template, and the account picked (else the caller's own). */
export function startBody({ templateId, person }) {
  return { templateId, ...(person?.id ? { principalId: person.id } : {}) };
}

/** Who answers: the account picked, else the default (the caller's own), else nobody yet. */
export const respondentOf = (person, options) => person ?? (options?.respondent
  ? { id: options.respondent.principalId, displayName: options.respondent.displayName, email: options.respondent.email }
  : null);

/** An account's e-mail as the pickers hand it over (/api/users calls it userPrincipalName). */
export const emailOf = (p) => p?.email || p?.userPrincipalName || null;

/** The pill of a request in the card's list: a survey done in place was never sent, so it never says "waiting". */
export function requestStatus(r) {
  if (!r.inPlace) return { key: r.status, label: { sent: 'waiting', submitted: 'answered', cancelled: 'withdrawn' }[r.status] ?? r.status };
  if (r.status === 'sent') return { key: 'sent', label: 'in progress' };
  return { key: r.status, label: r.status === 'submitted' ? 'answered in place' : 'withdrawn' };
}
