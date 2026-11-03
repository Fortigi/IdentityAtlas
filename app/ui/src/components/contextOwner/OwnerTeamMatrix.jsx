// A context owner's team matrix: the members of one of their units as rows,
// what each of them holds as columns. Opened from the unit's header ("Team
// matrix") inside the owner's shell (ContextOwnerPage).
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
import { teamMatrixFilter } from '@ui/utils/matrixFilter';
import MatrixArea from '@ui/components/app/MatrixArea';
import { readOnlyMatrixProps } from '@ui/components/shared/readOnlyMatrixProps';

const Status = ({ children, alert = false }) => (
  <p role={alert ? 'alert' : undefined} className="py-10 text-center text-sm text-gray-600 dark:text-gray-400">{children}</p>
);

export default function OwnerTeamMatrix({ contextId, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, error } = useFetch(`/api/contexts/${encodeURIComponent(contextId)}`, { authFetch });
  const attrs = data?.attributes || null;
  const filter = useMemo(() => (attrs ? teamMatrixFilter(attrs) : null), [attrs]);
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
        <MatrixArea {...readOnlyMatrixProps({ matrix, filter, managedFilter, setManagedFilter, onOpenDetail, noop })} />
      </Suspense>
    );
  }

  return (
    <section aria-label="Team matrix" className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Team matrix{attrs?.displayName ? ` — ${attrs.displayName}` : ''}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">Everyone in this unit as a row, and what each of them holds. Open a person or a resource for its details.</p>
      </div>
      {body}
    </section>
  );
}
