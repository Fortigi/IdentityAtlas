import { getAccessPackageColor } from '@ui/utils/colors';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { apBandBorderClass } from './headerMode';

// The right-hand end of every grouping header row: the access-package colour
// bands (their labels live on the pinned names row so they stay visible) and the
// three metadata placeholders (# | Type | Description). Every header row must
// emit these so its width still matches a resource row.
export default function MatrixHeaderRowTail({ accessPackages = [] }) {
  const isDark = useIsDark();
  return (
    <>
      {accessPackages.map((ap, idx) => (
        <th
          key={ap.id}
          className={`border-b border-r border-gray-200 dark:border-gray-600 ${apBandBorderClass(accessPackages, idx)}`}
          style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '24px', minWidth: '24px' }}
        />
      ))}
      <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px' }} />
      <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '180px' }} />
      <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '500px' }} />
    </>
  );
}
