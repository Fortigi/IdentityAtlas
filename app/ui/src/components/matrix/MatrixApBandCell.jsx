import { getAccessPackageColor } from '@ui/utils/colors';
import { isApCategoryBoundary, apLeftBorderClass } from './MatrixColumnHeaders.helpers';

// Access-package colour band placeholder on an attribute grouping row. The label
// itself lives on the pinned names row below so it stays visible on scroll.
export default function MatrixApBandCell({ accessPackages, idx, isDark }) {
  const isCategoryBoundary = isApCategoryBoundary(accessPackages, idx);
  return (
    <th
      className={`border-b border-r border-gray-200 dark:border-gray-600 ${apLeftBorderClass(idx, isCategoryBoundary)}`}
      style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '24px', minWidth: '24px' }}
    />
  );
}
