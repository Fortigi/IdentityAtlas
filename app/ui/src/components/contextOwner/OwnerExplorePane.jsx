// What a context owner has opened from their unit: the team matrix, or the
// detail page of a team member or of something the team holds — one at a time,
// stacked, with a way back. The detail pages are the ordinary ones
// (components/app/DetailRoute.jsx); every link inside them follows the API's
// access flag (components/EntityLink.jsx), and the API refuses anything else.

import { Suspense, useCallback, useRef } from 'react';
import DetailRoute from '@ui/components/app/DetailRoute';
import OwnerTeamMatrix from './OwnerTeamMatrix';

export default function OwnerExplorePane({ item, backLabel, onBack, onOpenDetail }) {
  const detailCacheRef = useRef({});
  const noop = useCallback(() => {}, []);
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} data-testid="owner-back"
        className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
        <span aria-hidden="true">←</span> Back to {backLabel}
      </button>
      {item.type === 'team-matrix' ? (
        <OwnerTeamMatrix key={item.id} contextId={item.id} onOpenDetail={onOpenDetail} />
      ) : (
        <Suspense fallback={<p className="py-10 text-center text-sm text-gray-600 dark:text-gray-400">Loading…</p>}>
          <DetailRoute page={`${item.type}:${item.id}`} detailCacheRef={detailCacheRef} onCacheData={noop}
            openDetailTab={onOpenDetail} closeDetailTab={onBack} />
        </Suspense>
      )}
    </div>
  );
}
