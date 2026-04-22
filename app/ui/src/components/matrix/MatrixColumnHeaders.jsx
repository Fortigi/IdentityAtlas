import { useState, useRef, useEffect } from 'react';
import { AP_COLORS, AP_COLORS_DARK } from '../../utils/colors';
import { useIsDark } from '../../contexts/ThemeContext';

export function getAccessPackageColor(index, isDark = false) {
  const palette = isDark ? AP_COLORS_DARK : AP_COLORS;
  return palette[index % palette.length];
}

export const BLANK_TAG = '__blank__';

export default function MatrixColumnHeaders({ users, infoColumnCount, onSortByCount, accessPackages = [], uniqueGroupTypes = [], groupTypeFilter, onGroupTypeFilterChange, uniqueGroupTags = [], groupTagFilter, onGroupTagFilterChange, hasGroupsWithoutTags = false, onOpenDetail }) {
  const isDark = useIsDark();
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const typeFilterRef = useRef(null);
  const tagFilterRef = useRef(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!typeFilterOpen && !tagFilterOpen) return;
    const handler = (e) => {
      if (typeFilterOpen && typeFilterRef.current && !typeFilterRef.current.contains(e.target)) {
        setTypeFilterOpen(false);
      }
      if (tagFilterOpen && tagFilterRef.current && !tagFilterRef.current.contains(e.target)) {
        setTagFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [typeFilterOpen, tagFilterOpen]);

  const isTypeFiltered = groupTypeFilter && groupTypeFilter.size > 0;

  const toggleTypeValue = (val) => {
    if (!groupTypeFilter) {
      // First selection: select only this one
      onGroupTypeFilterChange(new Set([val]));
    } else if (groupTypeFilter.has(val)) {
      const next = new Set(groupTypeFilter);
      next.delete(val);
      onGroupTypeFilterChange(next.size === 0 ? null : next);
    } else {
      onGroupTypeFilterChange(new Set([...groupTypeFilter, val]));
    }
  };

  const selectAllTypes = () => onGroupTypeFilterChange(null);

  const isTagFiltered = groupTagFilter && groupTagFilter.size > 0;

  const toggleTagValue = (val) => {
    if (!groupTagFilter) {
      onGroupTagFilterChange(new Set([val]));
    } else if (groupTagFilter.has(val)) {
      const next = new Set(groupTagFilter);
      next.delete(val);
      onGroupTagFilterChange(next.size === 0 ? null : next);
    } else {
      onGroupTagFilterChange(new Set([...groupTagFilter, val]));
    }
  };

  const selectAllTags = () => onGroupTagFilterChange(null);

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
                backgroundColor: getAccessPackageColor(idx, isDark),
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
        <th className={`sticky z-30 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium cursor-pointer select-none relative ${isTypeFiltered ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
            style={{ left: '299px', minWidth: '180px' }}
            ref={typeFilterRef}>
          <div onClick={() => setTypeFilterOpen(prev => !prev)}>
            Type {isTypeFiltered ? '\u25BC' : '\u25BD'}
          </div>
          {typeFilterOpen && (
            <div
              className="absolute bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-lg z-50 text-left"
              style={{ top: '100%', left: 0, minWidth: '200px' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-600">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={!isTypeFiltered}
                    onChange={selectAllTypes}
                    className="rounded"
                  />
                  (Select All)
                </label>
              </div>
              <div className="max-h-48 overflow-auto py-1">
                {uniqueGroupTypes.map(t => (
                  <label key={t} className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={!groupTypeFilter || groupTypeFilter.has(t)}
                      onChange={() => toggleTypeValue(t)}
                      className="rounded"
                    />
                    {t}
                  </label>
                ))}
              </div>
              {isTypeFiltered && (
                <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-600">
                  <button
                    onClick={selectAllTypes}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                  >
                    Clear filter
                  </button>
                </div>
              )}
            </div>
          )}
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
        <th className={`border-b border-gray-300 dark:border-gray-600 px-2 py-1 text-xs font-medium cursor-pointer select-none relative text-left ${isTagFiltered ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
            style={{ minWidth: '120px' }}
            ref={tagFilterRef}>
          <div onClick={() => setTagFilterOpen(prev => !prev)}>
            Tags {isTagFiltered ? '\u25BC' : '\u25BD'}
          </div>
          {tagFilterOpen && (
            <div
              className="absolute bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-lg z-50 text-left"
              style={{ top: '100%', right: 0, minWidth: '200px' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-600">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={!isTagFiltered}
                    onChange={selectAllTags}
                    className="rounded"
                  />
                  (Select All)
                </label>
              </div>
              <div className="max-h-48 overflow-auto py-1">
                {hasGroupsWithoutTags && (
                  <label className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 text-xs text-gray-500 dark:text-gray-400 italic">
                    <input
                      type="checkbox"
                      checked={!groupTagFilter || groupTagFilter.has(BLANK_TAG)}
                      onChange={() => toggleTagValue(BLANK_TAG)}
                      className="rounded"
                    />
                    (Blank)
                  </label>
                )}
                {uniqueGroupTags.map(t => (
                  <label key={t.name} className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 text-xs text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={!groupTagFilter || groupTagFilter.has(t.name)}
                      onChange={() => toggleTagValue(t.name)}
                      className="rounded"
                    />
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full border"
                      style={{ backgroundColor: t.color + '20', borderColor: t.color }}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
              {isTagFiltered && (
                <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-600">
                  <button
                    onClick={selectAllTags}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                  >
                    Clear filter
                  </button>
                </div>
              )}
            </div>
          )}
        </th>
      </tr>
    </thead>
  );
}
