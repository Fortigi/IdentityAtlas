import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import ContextPicker from '@ui/components/contexts/ContextPicker';
import { SurveyPreview } from './SurveyForm';
import { NEW_DEFINITION, parseJson } from './templateEditor.helpers';

// Editing one survey template: its name, what it applies to (a category, and
// optionally only under one context), and its questions as JSON — checked as
// you type (POST /api/surveys/templates/validate) and previewed as the
// respondent will see them. Saving changed questions makes a new version;
// surveys already sent keep the version they were sent with.
// The format: docs/architecture/survey-templates.md.

const CATEGORIES = [
  { value: 'OrganizationalUnit', label: 'Organisational unit' },
  { value: 'LogicalApplication', label: 'Logical application' },
];
const INPUT = 'w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300';

// The problems with the JSON as typed: a parse error, or the API's check.
function useDefinitionCheck(text) {
  const { authFetch } = useAuth();
  const settled = useDebouncedValue(text, 400);
  const [checked, setChecked] = useState({ text: null, errors: [] });
  useEffect(() => {
    const parsed = parseJson(settled);
    if (parsed.error) return undefined;
    let cancelled = false;
    authFetch('/api/surveys/templates/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: parsed.value }),
    }).then(r => r.json()).then((b) => { if (!cancelled) setChecked({ text: settled, errors: b.errors || [] }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [settled, authFetch]);
  const parsed = parseJson(text);
  if (parsed.error) return { parsed, errors: [{ path: '', message: `Not valid JSON: ${parsed.error}` }], pending: false };
  return { parsed, errors: checked.text === text ? checked.errors : [], pending: checked.text !== text };
}

function ScopeField({ scope, onChoose, onClear }) {
  return (
    <div>
      <span className={LABEL}>Only under</span>
      <div className="mt-1 flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
        <span data-testid="tpl-scope">{scope ? scope.displayName : 'Anywhere'}</span>
        <button type="button" onClick={onChoose} className="text-xs text-blue-700 underline dark:text-blue-300">choose</button>
        {scope && <button type="button" onClick={onClear} className="text-xs text-blue-700 underline dark:text-blue-300">clear</button>}
      </div>
    </div>
  );
}

function DefinitionErrors({ errors }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="list-disc space-y-0.5 rounded border border-red-200 bg-red-50 p-2 pl-6 text-xs text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
      {errors.map((e, i) => <li key={i}>{e.path ? <><code>{e.path}</code>: </> : null}{e.message}</li>)}
    </ul>
  );
}

// The fields of a template as the API takes them.
const initialFields = (t) => ({
  name: t?.name ?? '',
  description: t?.description ?? '',
  category: t?.contextCategory ?? 'OrganizationalUnit',
  scope: t?.scopeRootContextId ? { id: t.scopeRootContextId, displayName: t.scopeRootName } : null,
});

export default function TemplateEditor({ template, onSaved, onCancel }) {
  const { authFetch } = useAuth();
  const [initial] = useState(() => initialFields(template));
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [scope, setScope] = useState(initial.scope);
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(template?.definition ?? NEW_DEFINITION, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const check = useDefinitionCheck(text);
  const valid = !check.parsed.error && !check.pending && check.errors.length === 0;

  async function save() {
    setBusy(true); setError(null);
    try {
      const body = { name, description, contextCategory: category, scopeRootContextId: scope?.id ?? null, definition: check.parsed.value };
      const r = await authFetch(template ? `/api/surveys/templates/${template.id}` : '/api/surveys/templates', {
        method: template ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      onSaved(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div>
          <label htmlFor="tpl-name" className={LABEL}>Name</label>
          <input id="tpl-name" value={name} onChange={e => setName(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label htmlFor="tpl-description" className={LABEL}>Description</label>
          <input id="tpl-description" value={description} onChange={e => setDescription(e.target.value)} className={INPUT} />
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label htmlFor="tpl-category" className={LABEL}>Asked about</label>
            <select id="tpl-category" value={category} onChange={e => { setCategory(e.target.value); setScope(null); }} className={INPUT}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <ScopeField scope={scope} onChoose={() => setPicking(true)} onClear={() => setScope(null)} />
        </div>
        <div>
          <label htmlFor="tpl-definition" className={LABEL}>Questions (JSON)</label>
          <textarea id="tpl-definition" value={text} onChange={e => setText(e.target.value)} spellCheck={false} rows={24}
            className={`${INPUT} font-mono text-xs`} />
        </div>
        <DefinitionErrors errors={check.errors} />
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
          <button type="button" onClick={save} disabled={busy || !valid || !name.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300">Preview</h3>
        {valid
          ? <SurveyPreview definition={check.parsed.value} />
          : <p className="text-sm text-gray-600 dark:text-gray-400">The preview shows once the questions are valid.</p>}
      </div>
      {picking && (
        <ContextPicker open onClose={() => setPicking(false)} onPick={(node) => { setScope(node); setPicking(false); }}
          value={scope?.id ?? null} title="Only under this context" subtitle="The survey can be sent about this context and those below it." />
      )}
    </div>
  );
}
