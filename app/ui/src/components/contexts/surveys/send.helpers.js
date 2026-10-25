// Send survey — the pure part (SendSurveyModal / SendSurveyCard).

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
