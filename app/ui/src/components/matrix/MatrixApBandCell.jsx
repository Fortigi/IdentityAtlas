import { getAccessPackageColor } from '@ui/utils/colors';
import { isApCategoryBoundary, apLeftBorderClass, isProposedStart, PROPOSED_GAP_STYLE } from './MatrixColumnHeaders.helpers';

// Access-package colour band placeholder on an attribute grouping row. The label
// itself lives on the pinned names row below so it stays visible on scroll. Where
// the proposed roles start ("+ Proposed roles"), a gap, and "Proposed" above them.
export default function MatrixApBandCell({ accessPackages, idx, isDark }) {
  const isCategoryBoundary = isApCategoryBoundary(accessPackages, idx);
  const proposedStart = isProposedStart(accessPackages, idx);
  return (
    <th
      className={`border-b border-r border-gray-200 dark:border-gray-600 ${apLeftBorderClass(idx, isCategoryBoundary, proposedStart)}`}
      style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '24px', minWidth: '24px', ...(proposedStart ? PROPOSED_GAP_STYLE : {}) }}
    >
      {proposedStart && (
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-200" style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)', margin: '0 auto' }}>
          Proposed
        </span>
      )}
    </th>
  );
}
