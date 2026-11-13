import TabBar from '@ui/components/TabBar';

// The Contexts page's sub-tabs — one per template. No numbers: they would count
// trees, which a reader takes for units ("Organisation 9"). The kind of member
// (People · Accounts · Resources) is chosen in the tree panel's header.
export default function TemplateTabs({ tabs, active, onChange }) {
  const plain = (tabs || []).map(({ key, label }) => ({ key, label }));
  return (
    <div className="px-4 pt-3 border-b border-gray-200 dark:border-gray-700">
      <TabBar tabs={plain} active={active} onChange={onChange} />
    </div>
  );
}
