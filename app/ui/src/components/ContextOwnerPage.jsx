// A context owner's view of Identity Atlas.
//
// Somebody who is Accountable or Responsible for a context — a department's
// manager, an application's owner, a role portfolio's owner — signs in with their normal Microsoft
// account and, with no Identity Atlas role of their own, lands here instead of
// the app (AppRoot routes them; the Admin → Authentication switch lets them in).
// See docs/architecture/context-owner-access.md.
//
// The API only answers this user for their own contexts, the sub-units below
// them (all of them, whoever else owns one), and those contexts' variants
// (`contextOwner.contextIds` from /api/auth-me), so the page shows exactly
// that: the same sub-tabs and tree as the Contexts page, holding only what they
// answer for (contextOwner/OwnerTree.jsx), or a slim list if the tree cannot load.
// The context itself is the ordinary context page, wrapped in SharedViewContext
// so it renders read-only — no edits, no links into pages the owner may not
// open, and the workflows (the report download) kept — and in
// ContextOwnerScopeContext, so a sub-unit or parent in scope opens in place and
// each member can be expanded to its references (names only).
//
// When they also answer for business roles themselves (and that relative
// permission is on: /api/auth-me contextOwner.businessRoles), a Business roles tab
// joins the same row as Organisation and Applications: those roles, each opening read-only with its
// Composition review, where they may sign off (businessRoles/OwnerBusinessRoles.jsx).
// The page provides the feature flags itself — it is not inside App.

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useTheme } from '@ui/hooks/useTheme';
import { ThemeContext } from '@ui/contexts/ThemeContext';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { ContextOwnerScopeContext, OwnedBusinessRolesContext } from '@ui/contexts/ContextOwnerScopeContext';
import { FeaturesContext } from '@ui/contexts/FeaturesContext';
import useFeatures from '@ui/hooks/useFeatures';
import OwnerBusinessRoles from './businessRoles/OwnerBusinessRoles';
import ErrorBoundary from './ErrorBoundary';
import Brand from './app/Brand';
import { Avatar } from './DepartmentBadges';
import ContextDetailPage from './ContextDetailPage';
import ContextTemplateIcon from './contexts/ContextTemplateIcon';
import { categoryMeta } from '@ui/utils/contextStyles';
import OwnerExplorePane from './contextOwner/OwnerExplorePane';
import OwnerTreePane from './contextOwner/OwnerTree';
import { useOwnerTree, ownerPageTabs, ownerActiveTab, ROLES_TAB } from './contextOwner/useOwnerTree';
import TemplateTabs from './contexts/TemplateTabs';
import { OWNER_OPENABLE } from './contextOwner/ownerOpenable';

const ROLE_BADGE = {
  Accountable: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700',
  Responsible: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',
};

function RoleBadge({ role }) {
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[role] || ROLE_BADGE.Responsible}`}>
      {role}
    </span>
  );
}

// The signed-in owner, as the app's own header shows them (SettingsMenu): their
// profile photo when /api/auth-me matched them to an account that has one, else
// their initial.
function OwnerHeader({ isDark, userName, photo, onSignOut }) {
  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-6 py-3 flex items-center gap-4">
        <Brand isDark={isDark} />
        <div className="flex-1" />
        {userName && (
          <span className="flex min-w-0 items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Avatar name={userName} photo={photo} />
            <span className="truncate">{userName}</span>
          </span>
        )}
        {onSignOut && (
          <button type="button" onClick={onSignOut}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}

// What kind of context this is — an organisational unit, an application, a tag,
// a segment — by the same icon and label as the rest of the app (the Contexts
// tree, the detail tabs).
function KindIcon({ category }) {
  const label = categoryMeta(category).label;
  return (
    <span className="shrink-0 text-gray-600 dark:text-gray-400" title={label} data-testid="context-kind">
      <ContextTemplateIcon category={category} />
      <span className="sr-only">{label}: </span>
    </span>
  );
}

function ContextList({ contexts, selectedId, onSelect }) {
  return (
    <nav aria-label="What you answer for" className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-y-auto">
      <h2 className="px-2 mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">What you answer for</h2>
      <ul className="space-y-1">
        {contexts.map(c => (
          <li key={c.id}>
            <button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selectedId ? 'true' : undefined}
              className={`w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm ${c.id === selectedId
                ? 'bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
              <span className="flex min-w-0 items-center gap-2">
                <KindIcon category={c.contextCategory} />
                <span className="truncate">{c.displayName}</span>
              </span>
              <RoleBadge role={c.role} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// The units and applications they answer for: the tree (or a slim list) and the
// selected context — or what they opened from it, on top.
function ContextsView({ tree, contexts, selectedId, onSelect, current, backLabel, onBack, onOpenDetail }) {
  return (
    <>
      <div className="flex-1 min-h-0 flex">
        {tree.ready
          ? <OwnerTreePane nodes={tree.nodes} selectedId={selectedId} onSelect={onSelect} />
          : contexts.length > 1 && <ContextList contexts={contexts} selectedId={selectedId} onSelect={onSelect} />}
        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          {current && <OwnerExplorePane item={current} backLabel={backLabel} onBack={onBack} onOpenDetail={onOpenDetail} />}
          {selectedId && !current && (
            <ContextDetailPage key={selectedId} contextId={selectedId} embedded treeBeside={tree.ready || tree.pending} onOpenDetail={onOpenDetail} />
          )}
        </main>
      </div>
    </>
  );
}

// The business roles they answer for — or what they opened from one, on top. The
// list stays mounted underneath, so going back returns to the same role.
function RolesView({ roles, current, backLabel, onBack, onOpenDetail }) {
  return (
    <>
      {current && (
        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          <OwnerExplorePane item={current} backLabel={backLabel} onBack={onBack} onOpenDetail={onOpenDetail} />
        </main>
      )}
      <div className={current ? 'hidden' : 'flex-1 min-h-0 flex'}><OwnerBusinessRoles roles={roles} onOpenDetail={onOpenDetail} /></div>
    </>
  );
}

// "Back to …": the page below the one on top.
function backLabelOf(opened, showRoles, contexts, selectedId) {
  if (opened.length > 1) return opened[opened.length - 2].name;
  if (showRoles) return 'business roles';
  return contexts.find(c => c.id === selectedId)?.displayName || 'your unit';
}

function firstContext(contexts) {
  return contexts.find(c => c.contextCategory === 'OrganizationalUnit') || contexts[0];
}

export default function ContextOwnerPage() {
  const { contextOwner, account, me, logout } = useAuth();
  const { isDark, mode } = useTheme();
  const contexts = useMemo(() => contextOwner?.contexts || [], [contextOwner]);
  const businessRoles = useMemo(() => contextOwner?.businessRoles || [], [contextOwner]);
  const ownedRoles = useMemo(() => new Set(businessRoles.map(r => String(r.id).toLowerCase())), [businessRoles]);
  const features = useFeatures();
  const [view, setViewState] = useState('contexts');
  // The scope the API enforces: the held contexts, their own sub-units and their variants.
  const scope = useMemo(
    () => new Set([...(contextOwner?.contextIds || []), ...contexts.map(c => c.id)].map(id => String(id).toLowerCase())),
    [contextOwner, contexts],
  );
  // Opens on their organisation when they have one, the first tab of the tree.
  const [selectedId, setSelectedIdState] = useState(firstContext(contexts)?.id ?? null);
  // What the owner opened from the unit, newest last: the team matrix, a team
  // member's page, a page of something the team holds. Back pops one.
  const [opened, setOpened] = useState([]);
  const selectContext = useCallback((id) => { setSelectedIdState(id); setOpened([]); }, []);
  const tree = useOwnerTree(selectedId, selectContext);

  // The pages ask to open things. Another context in scope (a variant of this
  // unit, a sub-unit, a parent) opens in place; the team matrix and an object's
  // page open on top of it. The links only offer what the API marked openable,
  // and the API refuses the rest.
  const openDetail = useCallback((type, id, name) => {
    if (type === 'context') {
      if (scope.has(String(id).toLowerCase())) selectContext(id);
      return;
    }
    if (OWNER_OPENABLE.has(type) && id) setOpened(prev => [...prev, { type, id, name: name || id }]);
  }, [scope, selectContext]);
  const back = useCallback(() => setOpened(prev => prev.slice(0, -1)), []);
  const setView = useCallback((v) => { setViewState(v); setOpened([]); }, []);
  const showRoles = view === 'roles' && businessRoles.length > 0;
  const current = opened[opened.length - 1] || null;
  const backLabel = backLabelOf(opened, showRoles, contexts, selectedId);
  const tabs = ownerPageTabs(tree, businessRoles.length > 0);
  // Back from Business roles to the tab that was open keeps the unit they were on.
  const switchTab = (key) => {
    setView(key === ROLES_TAB ? 'roles' : 'contexts');
    if (key !== ROLES_TAB && tree.ready && key !== tree.active) tree.openTab(key);
  };

  return (
    <ThemeContext.Provider value={{ isDark, mode }}>
      <FeaturesContext.Provider value={features}>
      <SharedViewContext.Provider value={true}>
        <ContextOwnerScopeContext.Provider value={scope}>
        <OwnedBusinessRolesContext.Provider value={ownedRoles}>
          <ErrorBoundary>
            <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-gray-900">
              <OwnerHeader isDark={isDark} userName={account?.name || account?.username} photo={me?.photo} onSignOut={logout} />
              {tabs.length > 0 && <div className="bg-white dark:bg-gray-800"><TemplateTabs tabs={tabs} active={ownerActiveTab(tree, showRoles)} onChange={switchTab} /></div>}
              {showRoles
                ? <RolesView roles={businessRoles} current={current} backLabel={backLabel} onBack={back} onOpenDetail={openDetail} />
                : <ContextsView tree={tree} contexts={contexts} selectedId={selectedId} onSelect={selectContext}
                    current={current} backLabel={backLabel} onBack={back} onOpenDetail={openDetail} />}
            </div>
          </ErrorBoundary>
        </OwnedBusinessRolesContext.Provider>
        </ContextOwnerScopeContext.Provider>
      </SharedViewContext.Provider>
      </FeaturesContext.Provider>
    </ThemeContext.Provider>
  );
}
