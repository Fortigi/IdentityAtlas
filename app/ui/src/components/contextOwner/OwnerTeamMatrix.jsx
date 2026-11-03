// A context owner's matrix, opened from the context's header inside the
// owner's shell (ContextOwnerPage): the team matrix of a unit (its members as
// rows, what they hold as columns) or the application matrix of a context of
// resources (its resources as columns, their holders as rows).
//
// The filter is the team filter (utils/matrixFilter.js teamMatrixFilter), but
// the API is what bounds it: an owner's POST /api/matrix/data runs only when
// its rows are the members of an in-scope unit, whatever the client sends
// (app/api/src/auth/ownerAccess/matrixFilter.js). The matrix's side reads an
// owner may not make (tags, the access-package map, column labels, the default
// filter) answer 403 and the views carry on without them.

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useMatrix } from '@ui/hooks/useMatrix';
import { teamMatrixFilter, withUnitHierarchy } from '@ui/utils/matrixFilter';
import MatrixArea from '@ui/components/app/MatrixArea';
import { readOnlyMatrixProps } from '@ui/components/shared/readOnlyMatrixProps';

const Status = ({ children, alert = false }) => (
  <p role={alert ? 'alert' : undefined} className="py-10 text-center text-sm text-gray-600 dark:text-gray-400">{children}</p>
);

export default function OwnerTeamMatrix({ contextId, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, error } = useFetch(`/api/contexts/${encodeURIComponent(contextId)}`, { authFetch });
  const attrs = data?.attributes || null;
  // A unit opens grouped by its sub-units (collapsible, as an analyst's
  // hierarchy sort); "Group by unit" off gives the flat matrix, which also
  // draws the business-role band. Expanding or zooming a group edits the filter
  // (the API checks every unit it names is in scope).
  const [grouped, setGrouped] = useState(true);
  const [edited, setEdited] = useState(null);
  const filter = useMemo(() => {
    if (!attrs) return null;
    const base = teamMatrixFilter(attrs);
    return grouped ? (edited || withUnitHierarchy(base, attrs)) : base;
  }, [attrs, grouped, edited]);
  const groupable = !!attrs && withUnitHierarchy({}, attrs).sortHierarchy !== undefined;
  const toggleGrouped = () => { setGrouped(g => !g); setEdited(null); };
  const matrix = useMatrix(filter);
  const [managedFilter, setManagedFilter] = useState('all');
  const noop = useCallback(() => {}, []);

  let body;
  if (error) body = <Status alert>The unit could not be loaded.</Status>;
  else if (matrix.error) body = <Status alert>The team matrix could not be loaded: {matrix.error}</Status>;
  else if (!filter || matrix.loading) body = <Status>Loading the team matrix…</Status>;
  else {
    body = (
      <Suspense fallback={<Status>Loading the team matrix…</Status>}>
        <MatrixArea {...readOnlyMatrixProps({ matrix, filter, managedFilter, setManagedFilter, onOpenDetail, noop })} setMatrixFilter={setEdited} />
      </Suspense>
    );
  }

  const app = attrs?.targetType === 'Resource';
  const title = app ? 'Application matrix' : 'Team matrix';
  return (
    <section aria-label={title} className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{title}{attrs?.displayName ? ` — ${attrs.displayName}` : ''}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {app ? 'What is held here as columns, and everyone who holds it as a row.' : 'Everyone in this unit and the units below it as a row, and what each of them holds.'}
          {' Open a person or a resource for its details.'}
        </p>
        {groupable && (
          <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={grouped} onChange={toggleGrouped} data-testid="group-by-unit"
              className="rounded border-gray-300 dark:border-gray-600" />
            Group by unit
            <span className="text-xs text-gray-600 dark:text-gray-400">(off: one flat matrix, with the business roles)</span>
          </label>
        )}
      </div>
      {body}
    </section>
  );
}
