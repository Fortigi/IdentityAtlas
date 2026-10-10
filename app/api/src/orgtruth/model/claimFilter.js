// Organisation truth — the WHERE fragment the model summary applies to every
// claim row (OrgEntities / OrgRelations under alias `a`): rejected rows are left
// out, closed rows unless includeClosed, and one source with a sourceId filter.
// The sourceId value is bound; the closed filter is a fixed fragment.
export function claimFilter(a, { includeClosed, sourceId }, bind) {
  const parts = [`${a}.status <> 'rejected'`];
  if (!includeClosed) parts.push(`${a}."validTo" IS NULL`);
  if (sourceId) parts.push(`${a}."sourceId" = ${bind(sourceId)}::uuid`);
  return parts.join(' AND ');
}
