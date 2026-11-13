import { useEffect, useRef } from 'react';

// A workbench opened on a link to one saved proposed role (workbench.link.js):
// once the unit's data is on screen, open that investigation and put that role
// in the panel — once per investigation linked, so the analyst's later work is
// not overridden. A role the investigation no longer holds leaves its first one open.
export function useOpenLinked({ ready, investigationId, proposalId, open, dispatch }) {
  const opened = useRef(null);
  useEffect(() => {
    if (!ready || !investigationId || opened.current === investigationId) return;
    opened.current = investigationId;
    open(investigationId).then((inv) => {
      if (inv && proposalId && inv.proposals?.some(p => p.id === proposalId)) dispatch({ type: 'selectDraft', id: proposalId });
    });
  }, [ready, investigationId, proposalId, open, dispatch]);
}
