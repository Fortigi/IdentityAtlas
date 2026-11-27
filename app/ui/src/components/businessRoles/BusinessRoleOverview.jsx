import { useState } from 'react';
import BusinessRoleOwners from './BusinessRoleOwners';
import BusinessRoleResources from './BusinessRoleResources';
import BusinessRoleMembers from './BusinessRoleMembers';
import FoldSection from '@ui/components/contexts/FoldSection';
import { reviewWarnings } from './accessModel';

// ─── Overview of a business role ─────────────────────────────────────────
// The essentials: who answers for it, what it contains and who holds it — the
// last two folded to one line each, with their count — and a warning when its
// review was missed or none is set up. How people get, keep and lose the role
// is on the Lifecycle tab, which the warning links to.

function ReviewWarning({ warnings, onOpenLifecycle }) {
  if (warnings.length === 0) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
      <svg className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
      </svg>
      <div className="space-y-1">
        {warnings.map(w => <p key={w}>{w}</p>)}
        <button type="button" onClick={onOpenLifecycle} className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-100 dark:hover:text-amber-300">
          See the details on Lifecycle
        </button>
      </div>
    </div>
  );
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function BusinessRoleOverview({ roleId, data, onOpenDetail, onOpenTab }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) => (next) => setOpen(prev => {
    const s = new Set(prev);
    if (next) s.add(key); else s.delete(key);
    return s;
  });
  const resources = data.groupCount ?? 0;
  const people = data.assignmentCount ?? 0;
  return (
    <div className="space-y-4">
      <ReviewWarning warnings={reviewWarnings(data)} onOpenLifecycle={() => onOpenTab('lifecycle')} />
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Who answers for this role</h3>
        <BusinessRoleOwners roleId={roleId} onOpenDetail={onOpenDetail} />
      </section>
      <FoldSection id="role-resources" title="Resources" summary={count(resources, 'resource', 'resources')}
        open={open.has('resources')} onOpenChange={toggle('resources')}>
        <BusinessRoleResources roleId={roleId} onOpenDetail={onOpenDetail} />
      </FoldSection>
      <FoldSection id="role-people" title="People" summary={count(people, 'person', 'people')}
        open={open.has('people')} onOpenChange={toggle('people')}>
        <BusinessRoleMembers roleId={roleId} control={data.accessModel?.control} onOpenDetail={onOpenDetail} />
      </FoldSection>
    </div>
  );
}
