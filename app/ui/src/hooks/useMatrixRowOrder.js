import { useState, useEffect, useCallback } from 'react';

// Bump this when the default sort logic changes (e.g., staircase sort introduced).
// Stored orders from an older version are discarded so the new default takes effect.
const ROW_ORDER_VERSION = 5;

function getStorageKey(department) {
  return `fgraph-roworder-${department || 'all'}`;
}

export function useMatrixRowOrder(department, defaultGroupIds) {
  const [rowOrder, setRowOrder] = useState(null);

  // Load from localStorage when department changes
  useEffect(() => {
    try {
      const raw = localStorage.getItem(getStorageKey(department));
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.order && saved.version === ROW_ORDER_VERSION) {
          setRowOrder(saved.order);
          return;
        }
        // Discard stale order from older version
        localStorage.removeItem(getStorageKey(department));
      }
    } catch {}
    setRowOrder(null);
  }, [department]);

  // Save when order changes
  useEffect(() => {
    if (rowOrder === null) return;
    try {
      localStorage.setItem(getStorageKey(department), JSON.stringify({
        department,
        order: rowOrder,
        version: ROW_ORDER_VERSION,
        updatedAt: new Date().toISOString(),
      }));
    } catch {}
  }, [rowOrder, department]);

  // Apply order to group list: use saved order, append any new groups at the end
  const getOrderedGroups = useCallback((groups) => {
    if (!rowOrder) return groups;

    const groupMap = new Map(groups.map(g => [g.id, g]));
    const ordered = [];

    // Add groups in saved order
    for (const id of rowOrder) {
      if (groupMap.has(id)) {
        ordered.push(groupMap.get(id));
        groupMap.delete(id);
      }
    }

    // Append any new groups not in saved order
    for (const g of groupMap.values()) {
      ordered.push(g);
    }

    return ordered;
  }, [rowOrder]);

  const updateOrder = useCallback((newGroupIds) => {
    setRowOrder(newGroupIds);
  }, []);

  const resetOrder = useCallback(() => {
    setRowOrder(null);
    try {
      localStorage.removeItem(getStorageKey(department));
    } catch {}
  }, [department]);

  return {
    getOrderedGroups,
    updateOrder,
    resetOrder,
    hasCustomOrder: rowOrder !== null,
  };
}
