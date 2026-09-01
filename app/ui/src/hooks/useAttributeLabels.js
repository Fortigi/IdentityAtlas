import { useEffect, useReducer } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { loadAttributeLabels } from '@ui/utils/attributeLabels';

// Warm the shared attribute-label cache once, near the root of the app.
//
// Deliberately one call site rather than one per surface: the map is small, it
// changes only when a crawler runs, and everything that renders an attribute name
// reads it synchronously through `attributeLabel()`. The re-render this triggers
// on arrival is what turns the raw keys of the first paint into clean names.
export function useAttributeLabels() {
  const { authFetch } = useAuth();
  const [, bump] = useReducer(n => n + 1, 0);

  useEffect(() => {
    let alive = true;
    loadAttributeLabels(authFetch).then(() => { if (alive) bump(); });
    return () => { alive = false; };
  }, [authFetch]);
}
