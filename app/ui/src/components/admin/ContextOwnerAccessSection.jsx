import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

// Admin → Authentication → Authorization → Relative permissions: the
// context-owner access switch (RelativePermissionsSection holds it).
// GET/PUT /api/admin/context-owner-access ({ enabled }). When on, people who are
// Accountable or Responsible for a context can sign in without an Identity
// Atlas role and land on that context, its sub-units without an owner of their
// own, and the names of what its members hold — nothing else (the API enforces it).
export default function ContextOwnerAccessSection() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch('/api/admin/context-owner-access', { authFetch });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const enabled = data?.enabled === true;

  async function toggle(next) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch('/api/admin/context-owner-access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
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
          onChange={e => toggle(e.target.checked)}
        />
        <span className="text-sm text-gray-800 dark:text-gray-200">
          Context owners — people who are Accountable or Responsible for a context can sign in and see that
          context, its sub-units, its report and its workflows, even without an Identity Atlas role.
        </span>
      </label>
      <p className="mt-2 ml-7 text-xs text-gray-600 dark:text-gray-400">
        They land directly on their own context page, read-only. For each member they see the names of what
        that member holds and which other contexts it is in — names only, nothing they can open. A sub-unit
        with an owner of its own is that owner's. Everything else stays closed to them. People with an Identity
        Atlas role keep their normal access.
      </p>
      {message && <p role="alert" className="mt-2 ml-7 text-xs text-red-700 dark:text-red-400">{message}</p>}
    </div>
  );
}
