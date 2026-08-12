// Rotated (subjects-as-rows) Matrix view. Activated when the wizard's
// orientation toggle is set to 'rows-as-subjects'.
//
// This is a deliberately simpler render path than the default MatrixView:
//  - No SOLL / Access Package columns (the AP staircase + provisioning gap
//    machinery is tied to resource rows; pulling it apart is its own project).
//  - No Owner-row splitting (which only makes sense for resource rows).
//  - No nested-group expansion (resources are columns here; expand/collapse
//    doesn't have a natural meaning).
//  - The IST/SOLL/Gaps toggle in the toolbar collapses to All/IST/SOLL —
//    "Gaps" requires AP data and is hidden.
//
// Everything else (filter chip, share link, Excel export hook, basic
// per-cell membership-type badges) works the same as the default view.

import { useMemo, useCallback, useState, useRef } from 'react';
import useResizableGridHeight from '@ui/hooks/useResizableGridHeight';
import GridResizeHandle from './matrix/GridResizeHandle';
import MatrixToolbar from './matrix/MatrixToolbar';
import MatrixFilterSummary from './matrix/MatrixFilterSummary';
import MatrixCell from './matrix/MatrixCell';

function EmptyState({ onAdjustFilter, hasData }) {
  if (hasData === false) {
    return (
      <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 text-center bg-white dark:bg-gray-800">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">No data available yet</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
          Run a crawler first to import users and resources. Once data is loaded you can build a matrix here.
        </p>
      </div>
    );
  }
  if (hasData === null) return null;
  return (
    <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 text-center bg-white dark:bg-gray-800">
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">Pick a slice to inspect</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto mb-4">
        The Matrix tab always operates on a defined sub-selection of subjects (users or
        identities) and resources. Open the wizard to set up which slice to compare.
      </p>
      <button
        onClick={onAdjustFilter}
        className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
      >
        Create matrix
      </button>
    </div>
  );
}

export default function RotatedMatrixView({
  data,
  filter,
  counts,
  managedFilter, setManagedFilter,
  refreshing,
  shareUrl,
  onOpenDetail,
  onAdjustFilter,
  hasData,
}) {
  const filterIsApplied = filter !== null && filter !== undefined;

  // Cap the grid to the remaining viewport so only the grid scrolls, not the
  // page too — and let the analyst drag it to a height of their own (mirrors
  // MatrixView).
  const rootRef = useRef(null);
  const gridRef = useRef(null);
  const gridHeight = useResizableGridHeight(gridRef, [filterIsApplied]);
  const gridMaxH = gridHeight.height;

  // Same client-side managed-state toggle as MatrixView.
  const filteredData = useMemo(() => {
    let result = data;
    if (managedFilter === 'managed')        result = result.filter(d => !!d.managedByAccessPackage);
    else if (managedFilter === 'unmanaged') result = result.filter(d => !d.managedByAccessPackage);
    return result;
  }, [data, managedFilter]);

  // Build per-user and per-resource indexes + a cell map.
  const { users, resources, cellMap } = useMemo(() => {
    const userMap = new Map();
    const resourceMap = new Map();
    const cells = new Map(); // "userId|resourceId" -> Set of membership types

    for (const d of filteredData) {
      if (d.memberId && !userMap.has(d.memberId)) {
        userMap.set(d.memberId, {
          id: d.memberId,
          displayName: d.memberDisplayName || d.memberId,
          department: d.department || '',
          jobTitle: d.jobTitle || '',
          upn: d.memberUPN || '',
        });
      }
      const rid = d.resourceId || d.groupId;
      if (rid && !resourceMap.has(rid)) {
        resourceMap.set(rid, {
          id: rid,
          displayName: d.resourceDisplayName || d.groupDisplayName || rid,
          resourceType: d.resourceType || d.groupTypeCalculated || '',
          systemName: d.systemName || '',
        });
      }
      if (d.memberId && rid) {
        const key = `${d.memberId}|${rid}`;
        if (!cells.has(key)) cells.set(key, { types: new Set(), managed: false });
        cells.get(key).types.add(d.membershipType);
        if (d.managedByAccessPackage) cells.get(key).managed = true;
      }
    }

    // Sort users by displayName, resources by displayName (simple — no APs to staircase against).
    const users = [...userMap.values()].sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '')
    );
    const resources = [...resourceMap.values()].sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '')
    );

    return { users, resources, cellMap: cells };
  }, [filteredData]);

  // Group consecutive resources by resourceType for merged top header.
  const typeSpans = useMemo(() => {
    const spans = [];
    let i = 0;
    while (i < resources.length) {
      const t = resources[i].resourceType || '';
      let span = 1;
      while (i + span < resources.length && (resources[i + span].resourceType || '') === t) span++;
      spans.push({ type: t, span });
      i += span;
    }
    return spans;
  }, [resources]);

  // Share + export handlers (export not yet supported in rotated mode).
  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    } catch { return false; }
  }, [shareUrl]);

  const [exportTip, setExportTip] = useState(false);
  const handleExportExcel = useCallback(() => {
    setExportTip(true);
    setTimeout(() => setExportTip(false), 2500);
  }, []);

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {filterIsApplied && (
        <MatrixFilterSummary
          filter={filter}
          preview={counts}
          onAdjust={onAdjustFilter}
        />
      )}

      <MatrixToolbar
        managedFilter={managedFilter === 'gaps' ? 'all' : managedFilter}
        setManagedFilter={setManagedFilter}
        onExportExcel={handleExportExcel}
        onShare={handleShare}
        onResetRowOrder={() => {}}
        hasCustomRowOrder={false}
        hasExpandableGroups={false}
        hasExpandedGroups={false}
        onExpandAll={() => {}}
        onCollapseAll={() => {}}
      />

      {exportTip && (
        <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded px-3 py-1">
          Excel export is not yet supported in rotated layout. Switch to "Resources as rows" in the wizard to export.
        </div>
      )}

      {!filterIsApplied ? (
        <EmptyState onAdjustFilter={onAdjustFilter} hasData={hasData} />
      ) : users.length === 0 || resources.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          No assignments match the current matrix. Adjust the subjects or resources to widen the view.
        </div>
      ) : (
        <>
        <div ref={gridRef} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto" style={{ maxHeight: gridMaxH ? `${gridMaxH}px` : undefined }}>
          {refreshing && (
            <div className="absolute inset-0 bg-white/60 dark:bg-gray-900/60 z-10 flex items-center justify-center">
              <span className="text-xs text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 shadow-sm">Updating…</span>
            </div>
          )}
          <table className="border-collapse" style={{ tableLayout: 'fixed' }}>
            <thead className="sticky top-0 z-20">
              <tr>
                {/* Sticky left headers — display name + dept + jobTitle */}
                <th
                  colSpan={3}
                  className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 text-left font-medium"
                  style={{ minHeight: '120px' }}
                >
                  Subjects
                </th>
                {typeSpans.map((s, idx) => (
                  <th
                    key={idx}
                    colSpan={s.span}
                    className="border-b border-r border-gray-300 dark:border-gray-600 px-0 py-0 text-center bg-gray-100 dark:bg-gray-800"
                    style={{ height: '120px', minWidth: `${s.span * 24}px` }}
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
                      {s.type || '(no type)'}
                    </div>
                  </th>
                ))}
              </tr>
              <tr>
                <th
                  className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium text-gray-600 dark:text-gray-400"
                  style={{ minWidth: '220px' }}
                >
                  Display Name
                </th>
                <th
                  className="sticky z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium text-gray-600 dark:text-gray-400"
                  style={{ left: '220px', minWidth: '150px' }}
                >
                  Department
                </th>
                <th
                  className="sticky z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-left font-medium text-gray-600 dark:text-gray-400"
                  style={{ left: '370px', minWidth: '150px' }}
                >
                  Job Title
                </th>
                {resources.map(r => (
                  <th
                    key={r.id}
                    className="border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-gray-100 dark:bg-gray-800"
                    style={{ height: '100px', width: '24px', minWidth: '24px', verticalAlign: 'bottom' }}
                    title={`${r.displayName}\n${r.resourceType || ''}\n${r.systemName || ''}`}
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
                      onClick={() => onOpenDetail?.('resource', r.id, r.displayName)}
                    >
                      {r.displayName}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td
                    className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                    style={{ minWidth: '220px', maxWidth: '220px' }}
                    title={u.displayName}
                    onClick={() => {
                      const kind = filter?.rowType === 'identity' ? 'identity' : 'user';
                      onOpenDetail?.(kind, u.id, u.displayName);
                    }}
                  >
                    {u.displayName}
                  </td>
                  <td
                    className="sticky z-10 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 truncate"
                    style={{ left: '220px', minWidth: '150px', maxWidth: '150px' }}
                    title={u.department}
                  >
                    {u.department}
                  </td>
                  <td
                    className="sticky z-10 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 truncate"
                    style={{ left: '370px', minWidth: '150px', maxWidth: '150px' }}
                    title={u.jobTitle}
                  >
                    {u.jobTitle}
                  </td>
                  {resources.map(r => {
                    const cell = cellMap.get(`${u.id}|${r.id}`);
                    return (
                      <MatrixCell
                        key={r.id}
                        cellKey={`${u.id}|${r.id}`}
                        membershipTypes={cell?.types}
                        managed={cell?.managed}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <GridResizeHandle
          isCustom={gridHeight.isCustom}
          onStartDrag={gridHeight.startDrag}
          onResizeBy={gridHeight.resizeBy}
          onReset={gridHeight.reset}
        />
        </>
      )}
    </div>
  );
}
