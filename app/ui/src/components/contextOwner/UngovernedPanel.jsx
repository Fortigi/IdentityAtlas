// One person's ungoverned permissions, opened from their number in the team
// overview: what they hold that no business role of theirs explains, grouped so
// a manager can read it. Data: GET /api/contexts/:id/team-overview/:memberId/ungoverned.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EntityLink from '@ui/components/EntityLink';
import { Modal } from '@ui/components/contexts/ModalPrimitives';
import { groupUngoverned, HOW_LABEL } from './teamOverview.helpers';

const LINK = 'text-left text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-300';
const NOTE = 'py-4 text-center text-sm text-gray-600 dark:text-gray-400';

function Row({ item, onOpen }) {
  const tag = HOW_LABEL[item.how];
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <EntityLink kind="resource" id={item.id} label={item.displayName} accessible={item.accessible} onOpenDetail={onOpen} className={LINK} />
      {tag && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200">{tag}</span>}
    </li>
  );
}

function Sections({ items, onOpen }) {
  return groupUngoverned(items).map(section => (
    <section key={section.key} aria-label={section.label} className="mt-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">{section.label} ({section.items.length})</h4>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
        {section.items.map(item => <Row key={item.id} item={item} onOpen={onOpen} />)}
      </ul>
    </section>
  ));
}

export default function UngovernedPanel({ contextId, person, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const url = `/api/contexts/${encodeURIComponent(contextId)}/team-overview/${encodeURIComponent(person.id)}/ungoverned`;
  const { data, loading, error } = useFetch(url, { authFetch });
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const items = (data?.items || []).filter(i => !term || i.displayName.toLowerCase().includes(term));
  const open = onOpenDetail ? (kind, id, label) => { onClose(); onOpenDetail(kind, id, label); } : undefined;

  let body;
  if (loading) body = <p className={NOTE}>Loading…</p>;
  else if (error) body = <p role="alert" className={NOTE}>The list could not be loaded.</p>;
  else if (items.length === 0) body = <p className={NOTE}>{term ? 'Nothing matches this search.' : 'Nothing ungoverned.'}</p>;
  else body = <Sections items={items} onOpen={open} />;

  return (
    <Modal title={`Ungoverned permissions of ${person.displayName}`} subtitle="Access that none of their business roles explains." onClose={onClose} width={620}>
      <input type="search" aria-label="Search these permissions" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
        className="w-full rounded border border-gray-200 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
      {body}
      {data?.truncated && <p className={NOTE}>Showing the first {data.items.length}.</p>}
    </Modal>
  );
}
