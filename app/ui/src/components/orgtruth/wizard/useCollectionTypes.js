// Organisation → Import wizard: the collection types an activity's subject or
// a relation's end can point at (GET /api/org-truth/model → entityTypes whose
// template is collection; templateDraft.collectionTypes). A failing call lists
// none, so the target selects still offer the system types.
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { collectionTypes } from './templateDraft';
import { API } from './wizardApi';

export function useCollectionTypes() {
  const { authFetch } = useAuth();
  const { data } = useFetch(`${API}/model`, { authFetch, initialData: [], transform: collectionTypes });
  return data ?? [];
}
