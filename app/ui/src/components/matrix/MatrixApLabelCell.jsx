import { getAccessPackageColor } from '@ui/utils/colors';
import { isApCategoryBoundary, apLeftBorderClass } from './MatrixColumnHeaders.helpers';

// Access-package label cell on the pinned names row — carries the rotated AP
// name and opens the access-package detail on click.
export default function MatrixApLabelCell({ accessPackages, idx, isDark, onOpenDetail }) {
  const isCategoryBoundary = isApCategoryBoundary(accessPackages, idx);
  const ap = accessPackages[idx];
  return (
    <th
      className={`sticky top-0 z-20 border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${apLeftBorderClass(idx, isCategoryBoundary)}`}
      style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '24px', minWidth: '24px', height: '100px', verticalAlign: 'bottom' }}
      title={`${ap.displayName}\nCatalog: ${ap.catalogName || ''}${ap.categoryName ? '\nCategory: ' + ap.categoryName : ''}`}
    >
      <div
        className="text-[10px] text-gray-700 dark:text-gray-200 font-medium select-none cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
        style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '95px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto' }}
        onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
      >
        {ap.displayName}
      </div>
    </th>
  );
}
