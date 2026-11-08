import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

// Admin → Roles & Permissions → Relative permissions: the context-owner
// switches (RelativePermissionsSection holds them).
// GET/PUT /api/admin/context-owner-access ({ enabled, mcp }).
//   enabled — people who are Accountable or Responsible for a context can sign in
//     without an Identity Atlas role and land on that context, its sub-units and
//     what its members hold — nothing else (the API enforces it).
//   mcp — such people may also use the MCP server from an AI assistant, under
//     exactly the same scope. Only has effect while `enabled` is on, so its box is
//     disabled until then (docs/architecture/mcp-authorization.md).
export default function ContextOwnerAccessSection() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch('/api/admin/context-owner-access', { authFetch });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const enabled = data?.enabled === true;
  const mcp = data?.mcp === true;

  async function save(field, next) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch('/api/admin/context-owner-access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      reload();
    } catch (e) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const message = saveError || error?.message;
  return (
    <div>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={enabled}
          disabled={loading || saving}
          onChange={e => save('enabled', e.target.checked)}
        />
        <span className="text-sm text-gray-800 dark:text-gray-200">
          Context owners — people who are Accountable or Responsible for a context can sign in and see that
          context, its sub-units, its report and its workflows, even without an Identity Atlas role.
        </span>
      </label>
      <p className="mt-2 ml-7 text-xs text-gray-600 dark:text-gray-400">
        They land directly on their own context page, read-only, with every sub-unit below it. They can open the
        people in it and what those people hold (or, for an application, who holds it), and see the rest by name
        only. A sub-unit's own owner sees only their part. Everything else stays closed to them. People with an
        Identity Atlas role keep their normal access.
      </p>
      <label className={`mt-3 ml-7 flex items-start gap-3 ${enabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={mcp}
          disabled={!enabled || loading || saving}
          onChange={e => save('mcp', e.target.checked)}
        />
        <span className={`text-sm ${enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400'}`}>
          Context owners may also use the MCP server — ask questions about their own contexts from an AI assistant
          (Claude, ChatGPT, Microsoft 365 Copilot), seeing exactly what they see here and nothing more.
        </span>
      </label>
      <p className="mt-1 ml-14 text-xs text-gray-600 dark:text-gray-400">
        {enabled
          ? 'Every answer is limited to their contexts, and says so: counts cover their part only. The MCP server itself must be switched on under Admin → Experimental.'
          : 'Turn on context-owner access first.'}
      </p>
      {message && <p role="alert" className="mt-2 ml-7 text-xs text-red-700 dark:text-red-400">{message}</p>}
    </div>
  );
}
