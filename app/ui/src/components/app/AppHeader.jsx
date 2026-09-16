import Brand from './Brand';
import SettingsMenu from './SettingsMenu';
import AppNav from './AppNav';

// App shell header: brand, account/settings menu, and the tab strip.
export default function AppHeader({
  isDark, settingsRef, account, settingsOpen, onToggleSettings, onCloseSettings,
  mode, setTheme, optionalTabs, visibleTabs, toggleTab, logout,
  navTabs, detailTabs, page, navigate, closeDetailTab,
}) {
  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-3">
      <div className="flex items-center justify-between">
        <Brand isDark={isDark} />
        <SettingsMenu
          settingsRef={settingsRef}
          account={account}
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

      <AppNav
        navTabs={navTabs}
        detailTabs={detailTabs}
        page={page}
        navigate={navigate}
        closeDetailTab={closeDetailTab}
      />
    </header>
  );
}
