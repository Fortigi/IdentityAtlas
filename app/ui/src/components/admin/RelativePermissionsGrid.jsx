import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { CAPABILITY_COLUMNS, OWNER_ROLES, isOn, needsView, subjectLabel, withCell } from './relativePermissionsGrid.helpers';

// Admin → Roles & Permissions → Relative permissions: one grid of what people
// get because they are Accountable or Responsible for something — an
// organisation unit, an application, a role portfolio, a business role.
// GET/PUT /api/admin/context-owner-access ({ subjects, policy }). The rows and
// which cells each has come from the API (`subjects`); a tick saves the whole
// grid and shows what the server saved.
const URL = '/api/admin/context-owner-access';

function Cell({ subject, role, capability, applies, policy, busy, onToggle }) {
  if (!applies) return <td className="px-3 py-2 text-center text-gray-500 dark:text-gray-400" aria-hidden="true">–</td>;
  const blocked = needsView(capability) && !isOn(policy, subject, role, 'view');
  const name = `${subjectLabel(subject)} · ${role} · ${CAPABILITY_COLUMNS.find(c => c.key === capability).label}`;
  return (
    <td className="px-3 py-2 text-center">
      <input
        type="checkbox"
        className="h-4 w-4"
        aria-label={name}
        title={blocked ? 'Needs Sign in & view in this row first' : undefined}
        checked={isOn(policy, subject, role, capability)}
        disabled={busy || blocked}
        onChange={e => onToggle(subject, role, capability, e.target.checked)}
      />
    </td>
  );
}

export default function RelativePermissionsGrid() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch(URL, { authFetch });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const subjects = data?.subjects || [];
  const policy = data?.policy || {};

  async function toggle(subject, role, capability, value) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch(URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: withCell(policy, subject, role, capability, value) }),
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
  const busy = loading || saving;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border border-gray-200 dark:border-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-200">They answer for</th>
              <th scope="col" className="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-200">As</th>
              {CAPABILITY_COLUMNS.map(c => (
                <th key={c.key} scope="col" title={c.hint} className="px-3 py-2 text-center font-medium text-gray-700 dark:text-gray-200">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {subjects.flatMap(({ subject, capabilities }) => OWNER_ROLES.map((role, i) => (
              <tr key={`${subject}-${role}`}>
                {i === 0 && (
                  <th scope="rowgroup" rowSpan={OWNER_ROLES.length} className="px-3 py-2 text-left align-top font-medium text-gray-900 dark:text-white">
                    {subjectLabel(subject)}
                  </th>
                )}
                <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{role}</td>
                {CAPABILITY_COLUMNS.map(c => (
                  <Cell key={c.key} subject={subject} role={role} capability={c.key} applies={capabilities.includes(c.key)}
                    policy={policy} busy={busy} onToggle={toggle} />
                ))}
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 space-y-1 text-xs text-gray-600 dark:text-gray-400">
        {CAPABILITY_COLUMNS.map(c => <li key={c.key}><span className="font-medium">{c.label}</span> — {c.hint}</li>)}
        <li>
          Everything is read-only and limited to what they answer for; a sub-unit&apos;s own owner sees only their part.
          MCP and Composition review also need their feature switched on under Admin → Experimental.
          People with an Identity Atlas role keep their normal access.
        </li>
      </ul>
      {message && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{message}</p>}
    </div>
  );
}
