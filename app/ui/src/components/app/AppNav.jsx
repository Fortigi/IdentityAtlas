import NavTabButton from './NavTabButton';
import DetailTab from './DetailTab';

// The header's tab strip: the static primary tabs followed by the dynamic
// detail tabs.
export default function AppNav({ navTabs, detailTabs, page, navigate, closeDetailTab }) {
  return (
    <nav className="flex items-center gap-1 mt-3 -mb-4 border-b-0 overflow-x-auto">
      {navTabs.map(tab => (
        <NavTabButton
          key={tab.key}
          tab={tab}
          active={page === tab.key}
          onClick={() => navigate(tab.key)}
        />
      ))}

      {detailTabs.map(tab => {
        const tabKey = `${tab.type}:${tab.id}`;
        return (
          <DetailTab
            key={tabKey}
            tab={tab}
            active={page === tabKey}
            onSelect={() => navigate(tabKey)}
            onClose={closeDetailTab}
          />
        );
      })}
    </nav>
  );
}
