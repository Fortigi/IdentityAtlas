// The sections of the org-entity detail page that are pure presentation:
// the header card (name, type, status, observed, source with Download) and the
// relations in and out (each related entity opens its own detail tab). Kept
// apart from OrgEntityDetailPage.jsx, which owns the fetches and the graph.
import { formatDate } from '@ui/utils/formatters';
import { Section } from '@ui/components/DetailSection';
import { StatusPill, TypePill, LINK_BUTTON, SMALL_BUTTON, CARD } from './orgUi';

export function OrgEntityHeader({ entity, onDownload, onClose }) {
  const source = entity.source;
  return (
    <div className={`${CARD} p-4 flex flex-wrap items-start justify-between gap-4`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{entity.displayName}</h2>
          <TypePill type={entity.entityType} />
          <StatusPill status={entity.status} />
          {entity.validTo && <StatusPill status="closed" />}
        </div>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Observed {formatDate(entity.observedAt) || '—'}
          {entity.validTo ? ` · closed ${formatDate(entity.validTo)}` : ''}
          {source ? ` · from ${source.displayName}` : ''}
          {entity.sourceLocator ? ` (${entity.sourceLocator})` : ''}
        </p>
      </div>
      <div className="flex gap-2">
        {source && <button type="button" className={SMALL_BUTTON} onClick={() => onDownload(source)}>Download source</button>}
        {onClose && <button type="button" className={SMALL_BUTTON} onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}

// An out-relation names the other side in `to`; an in-relation in `from`
// (falling back to `to` should the API mirror the out shape).
function RelationList({ title, rows, arrow, otherSide, onOpenDetail }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400 mb-1">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">None.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map(r => {
            const other = otherSide(r) || {};
            return (
              <li key={r.id} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-600 dark:text-gray-400">{arrow(r.predicate)}</span>
                <button type="button" className={LINK_BUTTON}
                  onClick={() => onOpenDetail?.('org-entity', other.id, other.displayName)}>
                  {other.displayName}
                </button>
                <TypePill type={other.entityType} />
                {r.status !== 'accepted' && <StatusPill status={r.status} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function OrgEntityRelations({ relations, onOpenDetail }) {
  const out = relations?.out || [];
  const incoming = relations?.in || [];
  return (
    <Section title="Relations" count={out.length + incoming.length}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RelationList title="Out" rows={out} arrow={p => `${p} →`} otherSide={r => r.to} onOpenDetail={onOpenDetail} />
        <RelationList title="In" rows={incoming} arrow={p => `← ${p}`} otherSide={r => r.from || r.to} onOpenDetail={onOpenDetail} />
      </div>
    </Section>
  );
}
