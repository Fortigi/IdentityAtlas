// Authorization workbench — words and colours for organizational knowledge. Pure.
//
// "Duty" is the brief's holdsResponsibility: called duty on screen so it is never
// read as the role "Responsible" a unit or an application has.

export const KIND_STYLE = {
  activity: { label: 'Activity', cls: 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/40 dark:text-sky-200' },
  expertise: { label: 'Expertise', cls: 'border-violet-400 bg-violet-50 text-violet-800 dark:border-violet-500 dark:bg-violet-900/40 dark:text-violet-200' },
  duty: { label: 'Duty', cls: 'border-rose-400 bg-rose-50 text-rose-800 dark:border-rose-500 dark:bg-rose-900/40 dark:text-rose-200' },
};

export const STATE_LABEL = {
  confirmed: 'confirmed',
  proposed: 'proposed, not checked yet',
  disputed: 'disputed — sources disagree',
  rejected: 'rejected',
};

const SOURCE = {
  interview: (s) => `interview with ${s.name}`,
  file: (s) => s.fileName || 'a file',
  text: (s) => `notes by ${s.name}`,
};

/** "Confirmed by ann@x · interview with Piet de Vries, 2026-10-20". Pure. */
export function evidenceLine(claim) {
  const status = claim.status === 'proposed'
    ? `Proposed by ${claim.proposedBy === 'model' ? 'the model' : 'an analyst'}`
    : `${claim.status === 'rejected' ? 'Rejected' : 'Confirmed'}${claim.decidedBy ? ` by ${claim.decidedBy}` : ''}`;
  const s = claim.source || {};
  const from = (SOURCE[s.kind] || SOURCE.file)(s);
  const where = claim.contextName ? ` · about ${claim.contextName}` : '';
  return `${status} · ${from}${s.date ? `, ${s.date}` : ''}${where}`;
}

/** The names already used per kind, for the Add form's suggestions. Pure. */
export function knownNames(people) {
  const out = { activity: new Set(), expertise: new Set(), duty: new Set() };
  for (const p of people || []) for (const l of p.knowledge || []) if (out[l.kind] && l.state !== 'rejected') out[l.kind].add(l.name);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * What the header says is missing or uncertain: how many people have no
 * activity known, and how many links are proposed or disputed. Pure.
 */
export function knowledgeGaps(people) {
  let noActivity = 0;
  let proposed = 0;
  let disputed = 0;
  for (const p of people || []) {
    const links = (p.knowledge || []).filter(l => l.state !== 'rejected');
    if (!links.some(l => l.kind === 'activity')) noActivity++;
    proposed += links.filter(l => l.state === 'proposed').length;
    disputed += links.filter(l => l.state === 'disputed').length;
  }
  return { noActivity, proposed, disputed };
}
