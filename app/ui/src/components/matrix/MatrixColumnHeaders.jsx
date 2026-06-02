import { getApColor } from '../../utils/colors';
import { useIsDark } from '../../contexts/ThemeContext';

// Retained for backward-compat with code that imports it (drop-target sentinel
// for the old tag filter). The filter UI itself is gone.
const BLANK_TAG = '__blank__';

export default function MatrixColumnHeaders({
  users,
  infoColumnCount,
  onSortByCount,
  accessPackages = [],
  onOpenDetail,
}) {
  const isDark = useIsDark();

  // Group consecutive users by job title for merged headers
  const jobTitleSpans = [];
  let i = 0;
  while (i < users.length) {
    const title = users[i].jobTitle || '';
    let span = 1;
    while (i + span < users.length && (users[i + span].jobTitle || '') === title) {
      span++;
    }
    jobTitleSpans.push({ title, span, startIndex: i });
    i += span;
  }

  return (
    <thead className="sticky top-0 z-20">
      {/* Row 1: Job titles (merged cells) */}
      <tr>
        {/* Corner cells spanning info columns */}
        <th
          colSpan={infoColumnCount}
          className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1"
          style={{ minHeight: '120px' }}
        >
          <div className="text-xs text-gray-500 dark:text-gray-400 font-normal">
            <div>Drag rows to reorder</div>
          </div>
        </th>

        {jobTitleSpans.map((span, idx) => (
          <th
            key={idx}
            colSpan={span.span}
            className="border-b border-r border-gray-300 dark:border-gray-600 px-0 py-0 text-center bg-gray-100 dark:bg-gray-800"
            style={{
              height: '120px',
              minWidth: `${span.span * 24}px`,
            }}
          >
            <div
              className="text-[10px] font-semibold text-gray-700 dark:text-gray-300"
              style={{
                writingMode: 'vertical-lr',
                textOrientation: 'mixed',
                transform: 'rotate(180deg)',
                maxHeight: '110px',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                margin: '0 auto',
              }}
            >
              {span.title || '(no title)'}
            </div>
          </th>
        ))}

        {/* Access Package name headers (span both rows) */}
        {accessPackages.map((ap, idx) => {
          const prevCat = idx > 0 ? (accessPackages[idx - 1].categoryName || null) : undefined;
          const curCat = ap.categoryName || null;
          const isCategoryBoundary = idx === 0 || prevCat !== curCat;
          return (
            <th
              key={ap.id}
              rowSpan={2}
              className={`border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center ${idx === 0 ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500' : isCategoryBoundary ? 'border-l-2 border-l-gray-400 dark:border-l-gray-500' : ''}`}
              style={{
                backgroundColor: getApColor(idx, isDark),
                width: '24px',
                minWidth: '24px',
                verticalAlign: 'bottom',
              }}
              title={`${ap.displayName}\nCatalog: ${ap.catalogName || ''}${ap.categoryName ? '\nCategory: ' + ap.categoryName : ''}`}
            >
              <div
                className="text-[10px] text-gray-700 dark:text-gray-200 font-medium select-none cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                style={{
                  writingMode: 'vertical-lr',
                  textOrientation: 'mixed',
                  transform: 'rotate(180deg)',
                  maxHeight: '210px',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  margin: '0 auto',
                }}
                onClick={() => onOpenDetail?.('access-package', ap.id, ap.displayName)}
              >
                {ap.displayName}
              </div>
            </th>
          );
        })}

        {/* Right metadata column headers row 1 - empty placeholders (#, Description, Tags) */}
        <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px' }} />
        <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '500px' }} />
        <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '120px' }} />
      </tr>

      {/* Row 2: User names */}
      <tr>
        {/* Corner cells for row info headers */}
        <th className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-[10px] text-gray-500 dark:text-gray-400"
            style={{ minWidth: '24px' }}>
        </th>
        <th className="sticky z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 text-left font-medium"
            style={{ left: '24px', minWidth: '275px' }}>
          Resource Name
        </th>
        <th className="sticky z-30 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            style={{ left: '299px', minWidth: '180px' }}>
          Type
        </th>

        {users.map(user => (
          <th
            key={user.id}
            className="border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-gray-100 dark:bg-gray-800"
            style={{
              height: '100px',
              width: '24px',
              minWidth: '24px',
              verticalAlign: 'bottom',
            }}
            title={`${user.displayName}\n${user.jobTitle || ''}\n${user.department || ''}`}
          >
            <div
              className="text-[10px] text-gray-700 dark:text-gray-300 font-medium cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
              style={{
                writingMode: 'vertical-lr',
                textOrientation: 'mixed',
                transform: 'rotate(180deg)',
                maxHeight: '95px',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                margin: '0 auto',
              }}
              onClick={() => onOpenDetail?.('user', user.id, user.displayName)}
            >
              {user.displayName}
            </div>
          </th>
        ))}

        {/* Right metadata column headers row 2 — # | Description | Tags */}
        <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 text-[10px] text-gray-500 dark:text-gray-400 font-medium cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
            onClick={onSortByCount}
            title="Sort by member count (descending)">
          <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># &#x25BC;</div>
        </th>
        <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 font-medium text-left"
            style={{ minWidth: '500px' }}>
          Description
        </th>
        <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 text-xs font-medium text-left text-gray-500 dark:text-gray-400"
            style={{ minWidth: '120px' }}>
          Tags
        </th>
      </tr>
    </thead>
  );
}
