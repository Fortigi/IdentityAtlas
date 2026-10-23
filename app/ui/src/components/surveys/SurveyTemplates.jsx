import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import TemplateEditor from './TemplateEditor';

// The survey templates (an analyst's): the built-in ones and the analyst's own,
// archived ones last. A template is edited in place; archiving takes it out of
// the Send survey picker without touching surveys already sent.

const CATEGORY_LABEL = { OrganizationalUnit: 'Organisational unit', LogicalApplication: 'Logical application' };

export default function SurveyTemplates() {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const { data: templates, loading, error, reload } = useFetch('/api/surveys/templates?includeArchived=true', {
    authFetch, initialData: [], transform: b => b.data || [],
  });
  const [editing, setEditing] = useState(null); // null | 'new' | a template (with its definition)

  async function edit(t) {
    const r = await authFetch(`/api/surveys/templates/${t.id}`);
    if (!r.ok) { dialog.alert('The template could not be opened.'); return; }
    setEditing(await r.json());
  }

  async function setArchived(t, archived) {
    const r = await authFetch(`/api/surveys/templates/${t.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }),
    });
    if (!r.ok) dialog.alert('The template could not be changed.');
    reload();
  }

  if (editing) {
    return (
      <TemplateEditor template={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
        onSaved={(t) => { setEditing(null); reload(); dialog.toast(`Saved ${t.name} (version ${t.currentVersion}).`, { variant: 'success' }); }} />
    );
  }
  if (loading) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading templates…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-300">The templates could not be loaded ({error.message}).</p>;
  const sorted = [...templates].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt));
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={() => setEditing('new')}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600">
          New template
        </button>
      </div>
      <table className="min-w-full rounded-lg border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-800">
        <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-700/50 dark:text-gray-300">
          <tr>
            <th className="px-3 py-2 font-medium">Template</th>
            <th className="px-3 py-2 font-medium">Asked about</th>
            <th className="px-3 py-2 font-medium">Version</th>
            <th className="px-3 py-2 font-medium">Sent</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {sorted.map(t => (
            <tr key={t.id} className={t.archivedAt ? 'opacity-60' : ''}>
              <td className="px-3 py-2">
                <button type="button" onClick={() => edit(t)} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{t.name}</button>
                {t.builtIn && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-300">built in</span>}
                {t.archivedAt && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-300">archived</span>}
                {t.description && <div className="text-xs text-gray-600 dark:text-gray-400">{t.description}</div>}
              </td>
              <td className="px-3 py-2 text-gray-800 dark:text-gray-200">
                {CATEGORY_LABEL[t.contextCategory] ?? t.contextCategory}{t.scopeRootName ? ` under ${t.scopeRootName}` : ''}
              </td>
              <td className="px-3 py-2 text-gray-800 dark:text-gray-200">{t.currentVersion}</td>
              <td className="px-3 py-2 text-gray-800 dark:text-gray-200">{t.requestCount ?? 0}</td>
              <td className="px-3 py-2 text-right">
                <button type="button" onClick={() => setArchived(t, !t.archivedAt)} className="text-xs text-blue-700 underline dark:text-blue-300">
                  {t.archivedAt ? 'Restore' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
