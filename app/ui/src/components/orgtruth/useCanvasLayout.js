// Organisation → Model → the model canvas: the shared card layout.
//
//   const { saved, ready, move, commit, reset } = useCanvasLayout(canSave);
//
// `saved` is what GET /api/org-truth/canvas-layout returned ({ [cardId]: { x, y } },
// {} when nothing is stored or the read failed), replaced by the local layout
// once a card is moved. move(displayed, id, pos) places one card and keeps the
// rest where they are on screen; commit() — at the end of a drag — PUTs that
// whole layout so colleagues see the same picture; reset() PUTs an empty one
// (every card back to the automatic layout). Only someone who may edit the
// rules (canSave) writes; a reader still drags and resets, for this visit only.
// A failed save is a toast, never a lost card.
import { useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';

export const LAYOUT_URL = '/api/org-truth/canvas-layout';

const positionsOf = (data) => (data && typeof data.positions === 'object' && data.positions !== null ? data.positions : {});

export function useCanvasLayout(canSave) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const state = useFetch(LAYOUT_URL, { authFetch });
  const [local, setLocal] = useState(null);
  const latest = useRef(null);

  const put = async (positions) => {
    if (!canSave) return;
    try {
      const r = await authFetch(LAYOUT_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      dialog.toast(`The layout was not saved: ${e.message}`, { variant: 'error' });
    }
  };

  const move = (displayed, id, pos) => {
    const next = { ...displayed, [id]: pos };
    latest.current = next;
    setLocal(next);
  };
  const commit = () => (latest.current ? put(latest.current) : undefined);
  const reset = () => {
    latest.current = null;
    setLocal({});
    return put({});
  };

  return { saved: local ?? positionsOf(state.data), ready: !state.loading, move, commit, reset };
}
