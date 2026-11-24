import { useEffect, useRef, useState } from 'react';
import { fetchTreeSettings } from './NewContextWizard.helpers';

const jsonIfOk = async (r, fallback) => (r.ok ? r.json() : fallback);

// What the "New context tree" wizard reads when it opens: the rules, the
// systems, the account attributes and the existing generated trees. With
// `editTreeKey` it also reads that tree's settings and hands them to
// `onTreeSettings` ({ plugin, instanceKey, params }).
export function useWizardData({ open, authFetch, editTreeKey, onTreeSettings }) {
  const [systems, setSystems] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [principalAttrs, setPrincipalAttrs] = useState({ columns: [], extended: [] });
  const [genRoots, setGenRoots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // The latest callback, so a new function on each render does not reload.
  const onTreeRef = useRef(onTreeSettings);
  useEffect(() => { onTreeRef.current = onTreeSettings; });

  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setLoadError(null);
      try {
        const [pr, sr, cr, gr] = await Promise.all([
          authFetch('/api/context-plugins'),
          authFetch('/api/systems'),
          authFetch('/api/context-plugins/principal-attributes'),
          authFetch('/api/contexts?variant=generated'),
        ]);
        const list = (await jsonIfOk(pr, {})).data || [];
        const sys = await jsonIfOk(sr, []);
        const attrs = await jsonIfOk(cr, {});
        setPlugins(list);
        setSystems(sys.data || sys || []);
        setPrincipalAttrs({ columns: attrs.columns || [], extended: attrs.extended || [] });
        setGenRoots((await jsonIfOk(gr, {})).data || []);
        if (editTreeKey) onTreeRef.current?.(await fetchTreeSettings(authFetch, editTreeKey, list));
      } catch (e) {
        setLoadError(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, authFetch, editTreeKey]);

  return { systems, plugins, principalAttrs, genRoots, loading, loadError };
}
