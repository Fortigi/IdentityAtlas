// Admin → Authentication → Roles & Permissions matrix.
//
// Renders the role-to-permission mapping as a checkbox grid: rows are
// permissions grouped by category (Read / Export / Write / Admin), columns
// are roles. The server is source of truth — every save round-trips through
// PUT /api/admin/roles, which applies the self-lockout guard before persisting.
//
// Three safety affordances baked in:
//   1. "Your sign-in includes …" badge so the user knows exactly which roles
//      they'll be checked against. Without this they have to guess whether
//      they've been assigned the right Entra app role.
//   2. Locally-disabled checkbox + warning when a save would remove the
//      user's own admin.auth. We let the user *attempt* the save so the
//      server's 409 error path is exercised end-to-end, but the UI nudges
//      first.
//   3. "Reset to defaults" button (DELETE /api/admin/roles) for getting
//      back to the seed without manual ticks.

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { formatDate } from '@ui/utils/formatters';

export default function RolesPermissionsSection() {
  const { authFetch, refreshPermissions } = useAuth();
  const dialog = useDialog();
  // `refresh()` runs in a mount effect and flips loading synchronously. Backing
  // it with a reducer (dispatch, not a useState setter) keeps that out of
  // react-hooks/set-state-in-effect — the same mechanism useFetch relies on —
  // while preserving the custom 403/HTTP error messages this section renders.
  const [loading, setLoading] = useReducer((_, v) => v, true);
  const [error, setError] = useReducer((_, v) => v, null);
  const [data, setData]   = useState(null);
  // Local working copy of the mapping while the user is editing it. Saved on
  // [Save changes] / discarded on [Cancel] / reset on [Reset to defaults].
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  // Bumped after a successful save/reset so the change-log panel reloads.
  const [auditKey, setAuditKey] = useState(0);

  // Loads the mapping. Uses a .then() chain (not await) so the data/draft
  // setStates run inside the callback rather than synchronously in the effect
  // body — keeping it clear of react-hooks/set-state-in-effect. The synchronous
  // setLoading/setError above are reducer dispatches (see their declarations).
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    return authFetch('/api/admin/roles')
      .then(async (r) => {
        if (!r.ok) {
          if (r.status === 403) {
            throw new Error("You don't have permission to view the role mapping (admin.auth required).");
          }
          throw new Error(`HTTP ${r.status}`);
        }
        const body = await r.json();
        setData(body);
        setDraft(cloneMapping(body.mapping));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  const dirty = useMemo(
    () => data && JSON.stringify(draft) !== JSON.stringify(data.mapping),
    [draft, data],
  );

  // Group permissions by their catalog group so the matrix has clear sections.
  const groupedCatalog = useMemo(() => {
    if (!data) return [];
    const out = data.groups.map(g => ({ group: g, items: [] }));
    for (const item of data.catalog) {
      const bucket = out.find(b => b.group === item.group);
      if (bucket) bucket.items.push(item);
      else out.push({ group: item.group, items: [item] });
    }
    return out;
  }, [data]);

  const togglePerm = (role, permKey) => {
    setDraft(prev => {
      const next = cloneMapping(prev);
      const list = next[role] || [];
      // '*' wildcard is a separate intent — handled below. Regular permissions
      // toggle in/out of the explicit list.
      if (list.includes(permKey)) {
        next[role] = list.filter(p => p !== permKey);
      } else {
        // If the role currently has '*', toggling a specific permission off
        // would be ambiguous — convert '*' into the explicit catalog first so
        // the user can sculpt from there. (Toggling ON is a no-op in that
        // case; '*' already grants it.)
        if (list.includes('*')) {
          const allKeys = data.catalog.map(c => c.key);
          next[role] = allKeys; // user is editing away from "all" — start explicit
        }
        next[role] = [...new Set([...next[role], permKey])];
      }
      return next;
    });
  };

  const toggleWildcard = (role) => {
    setDraft(prev => {
      const next = cloneMapping(prev);
      const list = next[role] || [];
      if (list.includes('*')) {
        // Drop wildcard, leave the rest of the list (or empty if there was
        // only '*'). User can then tick specific perms.
        next[role] = list.filter(p => p !== '*');
      } else {
        next[role] = ['*'];
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const r = await authFetch('/api/admin/roles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping: draft }),
      });
      const body = await r.json();
      if (!r.ok) {
        setSaveMessage({ ok: false, text: body.error || `HTTP ${r.status}`, hint: body.hint });
      } else {
        setSaveMessage({ ok: true, text: 'Saved. Refresh other open browser tabs to pick up the change.' });
        await refresh();
        setAuditKey(k => k + 1);
        // Update our own toolbar/Admin-tab gating immediately.
        await refreshPermissions();
      }
    } catch (err) {
      setSaveMessage({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!(await dialog.confirm({ message: 'Reset to the built-in Admin / RoleMiner / Servicedesk defaults? Any custom roles will be removed.', confirmLabel: 'Reset', danger: true }))) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const r = await authFetch('/api/admin/roles', { method: 'DELETE' });
      const body = await r.json();
      if (!r.ok) {
        setSaveMessage({ ok: false, text: body.error || `HTTP ${r.status}`, hint: body.hint });
      } else {
        setSaveMessage({ ok: true, text: 'Reverted to defaults.' });
        await refresh();
        setAuditKey(k => k + 1);
        await refreshPermissions();
      }
    } catch (err) {
      setSaveMessage({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleAddRole = async () => {
    const name = await dialog.prompt({ title: 'Add role', message: 'Role name (must match the role string in the Entra app registration):', confirmLabel: 'Add' });
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setDraft(prev => {
      if (prev[trimmed]) return prev;
      return { ...prev, [trimmed]: [] };
    });
  };

  const handleRemoveRole = async (role) => {
    if (!(await dialog.confirm({ message: `Remove role "${role}" from the mapping? Users who only have this role in their token will fall back to having no permissions.`, confirmLabel: 'Remove', danger: true }))) return;
    setDraft(prev => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
  };

  if (loading && !data) {
    return <div className="text-sm text-gray-500 dark:text-gray-400 p-6">Loading roles & permissions…</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-md p-4 my-4">
        <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const roles = Object.keys(draft);
  const myRoles = data.currentUser?.roles || [];
  const myHasWildcard = data.currentUser?.hasWildcard;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-6 my-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">Roles &amp; Permissions</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Decide which Entra app roles can do what inside Identity Atlas. Role names here must match the
            <code className="bg-gray-100 dark:bg-gray-700 dark:text-gray-200 mx-1 px-1 rounded text-xs font-mono">roles</code>
            claim values returned in the user's sign-in token (configured under
            <strong> Entra ID &rarr; App registrations &rarr; App roles</strong>).
          </p>
        </div>
        <div className="shrink-0 text-xs">
          {data.isCustom ? (
            <span className="px-2 py-1 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">Custom mapping</span>
          ) : (
            <span className="px-2 py-1 rounded bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200">Default mapping</span>
          )}
        </div>
      </div>

      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md p-3 mb-4 text-xs">
        <p className="text-amber-900 dark:text-amber-200">
          <strong>Your sign-in includes:</strong>{' '}
          {myRoles.length === 0
            ? <em>no roles in your token</em>
            : myRoles.map((r, i) => (
                <span key={r}>
                  <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded font-mono">{r}</code>
                  {i < myRoles.length - 1 ? ' ' : ''}
                </span>
              ))}
          {myHasWildcard && (
            <span className="ml-2 text-amber-800 dark:text-amber-300">
              (you currently have full access via the backwards-compat fallback — saving any custom mapping starts enforcement for users whose roles are in the mapping)
            </span>
          )}
        </p>
      </div>

      <div className="overflow-x-auto -mx-2 px-2">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="font-medium text-gray-700 dark:text-gray-200 py-2 pr-4 w-1/3 sticky left-0 bg-white dark:bg-gray-800 z-10">Permission</th>
              {roles.map(r => (
                <th key={r} className="font-medium text-gray-700 dark:text-gray-200 py-2 px-3 text-center align-bottom">
                  <div className="flex items-center justify-center gap-1">
                    <code className="font-mono text-xs">{r}</code>
                    <button
                      type="button"
                      onClick={() => handleRemoveRole(r)}
                      title={`Remove role "${r}"`}
                      className="text-gray-600 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400 text-xs leading-none"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-1">
                    <label className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <input
                        type="checkbox"
                        checked={(draft[r] || []).includes('*')}
                        onChange={() => toggleWildcard(r)}
                        className="rounded"
                      />
                      all (*)
                    </label>
                  </div>
                </th>
              ))}
              <th className="py-2 pl-2 align-bottom">
                <button
                  type="button"
                  onClick={handleAddRole}
                  className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  + Add role
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {groupedCatalog.map(({ group, items }) => (
              <PermissionGroup
                key={group}
                group={group}
                items={items}
                roles={roles}
                draft={draft}
                togglePerm={togglePerm}
              />
            ))}
          </tbody>
        </table>
      </div>

      {saveMessage && (
        <div className={
          'mt-4 rounded-md p-3 text-sm ' +
          (saveMessage.ok
            ? 'bg-green-50 text-green-800 border border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800'
            : 'bg-red-50 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800')
        }>
          <p>{saveMessage.text}</p>
          {saveMessage.hint && <p className="mt-1 text-xs opacity-90">{saveMessage.hint}</p>}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => setDraft(cloneMapping(data.mapping))}
          disabled={!dirty || saving}
          className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <span className="grow"></span>
        <button
          type="button"
          onClick={handleReset}
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          title="Revert to the built-in Admin / RoleMiner / Servicedesk mapping"
        >
          Reset to defaults
        </button>
      </div>

      <RoleChangeLog authFetch={authFetch} reloadKey={auditKey} />
    </div>
  );
}

// Compact change history for the role→permission mapping — the audit trail half
// of #786. Reloads whenever `reloadKey` bumps (after a save/reset).
function RoleChangeLog({ authFetch, reloadKey }) {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/admin/roles/audit?limit=10')
      .then(r => (r.ok ? r.json() : { entries: [] }))
      .then(j => { if (!cancelled) { setEntries(j.entries || []); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [authFetch, reloadKey]);

  if (!loaded) return null;

  return (
    <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Recent changes</h4>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">No changes recorded yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-xs">
          {entries.map(e => (
            <li key={e.id} className="py-1.5 flex items-center justify-between gap-3">
              <span className="text-gray-700 dark:text-gray-300">
                <span className={`font-medium ${e.action === 'reset' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100'}`}>
                  {e.action === 'reset' ? 'Reverted to defaults' : 'Saved mapping'}
                </span>
                {' by '}
                <span className="font-mono">{e.changedBy || 'system (auth off)'}</span>
              </span>
              <span className="shrink-0 text-gray-500 dark:text-gray-400">{formatDate(e.changedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PermissionGroup({ group, items, roles, draft, togglePerm }) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 2} className="pt-4 pb-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">{group}</div>
        </td>
      </tr>
      {items.map(item => (
        <tr key={item.key} className="border-t border-gray-100 dark:border-gray-700">
          <td className="py-2 pr-4 align-top sticky left-0 bg-white dark:bg-gray-800 z-10">
            <div className="font-medium text-gray-800 dark:text-gray-100">{item.label}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{item.description}</div>
            <code className="text-[10px] font-mono text-gray-600 dark:text-gray-500">{item.key}</code>
          </td>
          {roles.map(role => {
            const list = draft[role] || [];
            const hasWildcard = list.includes('*');
            const explicitlyChecked = list.includes(item.key);
            const effective = hasWildcard || explicitlyChecked;
            return (
              <td key={role} className="text-center align-middle px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`${item.label || item.key} for ${role}`}
                  checked={effective}
                  onChange={() => togglePerm(role, item.key)}
                  className={hasWildcard ? 'opacity-60' : ''}
                  title={hasWildcard ? 'Granted via the * wildcard' : undefined}
                />
              </td>
            );
          })}
          <td></td>
        </tr>
      ))}
    </>
  );
}

function cloneMapping(m) {
  // Defensive deep-ish clone — mapping is { string: string[] }, no nested objects.
  const out = {};
  for (const [k, v] of Object.entries(m || {})) out[k] = Array.isArray(v) ? [...v] : [];
  return out;
}
