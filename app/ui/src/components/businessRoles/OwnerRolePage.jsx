// One business role a context owner answers for themselves, as its ordinary page
// (ContextOwnerPage, picked under its portfolio on the Role portfolios tab). The
// page is read-only (the owner's shell is a shared view) except its Composition
// review, where they may sign off (OwnedBusinessRolesContext). The API opens only
// the roles in /api/auth-me contextOwner.businessRoles.

import { Suspense, useCallback, useRef } from 'react';
import DetailRoute from '@ui/components/app/DetailRoute';

export default function OwnerRolePage({ roleId, onOpenDetail }) {
  const detailCacheRef = useRef({});
  const noop = useCallback(() => {}, []);
  return (
    <Suspense fallback={<p className="py-10 text-center text-sm text-gray-600 dark:text-gray-400">Loading…</p>}>
      <DetailRoute key={roleId} page={`access-package:${roleId}`} detailCacheRef={detailCacheRef} onCacheData={noop}
        openDetailTab={onOpenDetail} closeDetailTab={noop} />
    </Suspense>
  );
}
