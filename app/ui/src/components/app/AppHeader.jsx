import Brand from './Brand';
import SettingsMenu from './SettingsMenu';
import AppNav from './AppNav';
import { useHasPermission } from '@ui/auth/usePermissions';
import { isScopedContextPage } from '@ui/App.helpers';

// App shell header: brand, account/settings menu, and the tab strip. A
// context page seen by someone who cannot edit contexts is the business view
// of a unit: it is shown without the tab strip (the page has a breadcrumb).
export default function AppHeader({
  isDark, settingsRef, account, me, settingsOpen, onToggleSettings, onCloseSettings,
  mode, setTheme, optionalTabs, visibleTabs, toggleTab, logout,
  navTabs, detailTabs, page, navigate, closeDetailTab,
}) {
  const canWriteContexts = useHasPermission('data.write.contexts');
  const scoped = isScopedContextPage(page, canWriteContexts);
  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-3">
      <div className="flex items-center justify-between">
        <Brand isDark={isDark} />
        <SettingsMenu
          settingsRef={settingsRef}
          account={account}
          me={me}
          settingsOpen={settingsOpen}
          onToggle={onToggleSettings}
          onClose={onCloseSettings}
          mode={mode}
          setTheme={setTheme}
          optionalTabs={optionalTabs}
          visibleTabs={visibleTabs}
          toggleTab={toggleTab}
          logout={logout}
        />
      </div>

      {!scoped && <AppNav
        navTabs={navTabs}
        detailTabs={detailTabs}
        page={page}
        navigate={navigate}
        closeDetailTab={closeDetailTab}
      />}
    </header>
  );
}
