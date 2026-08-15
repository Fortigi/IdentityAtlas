import { lazy, createElement } from 'react';
import { parseDetailRoute } from '@ui/App.helpers';

// Lazy-load the detail page components (route-based code splitting).
const UserDetailPage = lazy(() => import('@ui/components/UserDetailPage'));
const ResourceDetailPage = lazy(() => import('@ui/components/ResourceDetailPage'));
const AccessPackageDetailPage = lazy(() => import('@ui/components/AccessPackageDetailPage'));
const DepartmentDetailPage = lazy(() => import('@ui/components/DepartmentDetailPage'));
const ContextDetailPage = lazy(() => import('@ui/components/ContextDetailPage'));
const RunDetailPage = lazy(() => import('@ui/components/RunDetailPage'));
const IdentityDetailPage = lazy(() => import('@ui/components/IdentityDetailPage'));

// hash type → { detail page component, its id prop, whether it takes the cache }.
// #group: is backward-compat and reuses ResourceDetailPage.
const DETAIL_ROUTES = {
  user:              { Comp: UserDetailPage,          idProp: 'userId' },
  resource:          { Comp: ResourceDetailPage,      idProp: 'resourceId' },
  group:             { Comp: ResourceDetailPage,      idProp: 'resourceId' },
  'access-package':  { Comp: AccessPackageDetailPage, idProp: 'accessPackageId' },
  department:        { Comp: DepartmentDetailPage,    idProp: 'departmentName' },
  context:           { Comp: ContextDetailPage,       idProp: 'contextId' },
  identity:          { Comp: IdentityDetailPage,      idProp: 'identityId' },
  run:               { Comp: RunDetailPage,           idProp: 'runId', noCache: true },
};

// Renders the detail page for the current hash, or null when the hash is not a
// known detail route. Built via createElement (not called as a component
// factory) so the user-controlled hash key never reaches callee position.
export default function DetailRoute({ page, detailCacheRef, onCacheData, openDetailTab, closeDetailTab }) {
  const route = parseDetailRoute(page);
  if (!route) return null;
  const cfg = DETAIL_ROUTES[route.type];
  if (!cfg) return null;

  const { type, id } = route;
  const cacheKey = `${type}:${id}`;
  const props = {
    key: cacheKey,
    [cfg.idProp]: id,
    onClose: () => closeDetailTab(type, id),
    onOpenDetail: openDetailTab,
  };
  if (!cfg.noCache) {
    // detailCacheRef is an intentional mutable per-tab render cache (cachedData
    // for instant detail display); reading .current here mirrors App's ref use.
    props.cachedData = detailCacheRef.current[cacheKey];
    props.onCacheData = onCacheData;
  }
  return createElement(cfg.Comp, props);
}
