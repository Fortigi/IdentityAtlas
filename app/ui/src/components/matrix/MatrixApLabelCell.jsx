import { getAccessPackageColor } from '@ui/utils/colors';
import { isApCategoryBoundary, apLeftBorderClass } from './MatrixColumnHeaders.helpers';
import RotatedLabelButton from './RotatedLabelButton';

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
      <RotatedLabelButton
        className="text-[10px] text-gray-700 dark:text-gray-200 font-medium select-none hover:text-blue-600 dark:hover:text-blue-400"
        style={{ maxHeight: '95px' }}
        onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
      >
        {ap.displayName}
      </RotatedLabelButton>
    </th>
  );
}
