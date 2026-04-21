import { useState, useEffect } from 'react';
import { useAuth } from '../../auth/AuthGate';

// Minimal wizard for creating a manual root context. Target type + context
// type + name + optional description + optional scope system.

export default function CreateManualTreeModal({ open, onClose, onCreated }) {
  const { authFetch } = useAuth();
  const [targetType, setTargetType] = useState('Identity');
  const [contextType, setContextType] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [scopeSystemId, setScopeSystemId] = useState('');
  const [systems, setSystems] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await authFetch('/api/systems');
        if (r.ok) {
          const body = await r.json();
          setSystems(body.data || body || []);
        }
      } catch { /* non-critical */ }
    })();
  }, [open, authFetch]);

  useEffect(() => {
    if (!open) {
      setTargetType('Identity'); setContextType(''); setDisplayName('');
      setDescription(''); setScopeSystemId(''); setError(null); setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const canSubmit = !!displayName.trim() && !!contextType.trim() && !submitting;

  async function submit() {
    setSubmitting(true); setError(null);
    try {
      const body = {
        targetType,
        contextType: contextType.trim(),
        displayName: displayName.trim(),
        description: description.trim() || null,
        scopeSystemId: scopeSystemId ? parseInt(scopeSystemId, 10) : null,
      };
      const r = await authFetch('/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const created = await r.json();
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create context');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create manual tree" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Target type" help="What kind of entities will this tree contain.">
          <select value={targetType} onChange={e => setTargetType(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
            <option value="Identity">Identity</option>
            <option value="Resource">Resource</option>
            <option value="Principal">Principal</option>
            <option value="System">System</option>
          </select>
        </Field>
        <Field label="Context type" help="Free-form sub-classification (e.g. Application, BusinessProcess, Team).">
          <input
            value={contextType} onChange={e => setContextType(e.target.value)}
            placeholder="Application"
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Display name">
          <input
            value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder="Procurement app"
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            rows={2}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Scope system (optional)" help="Pin this tree to a specific source system. Leave blank for a cross-system tree.">
          <select value={scopeSystemId} onChange={e => setScopeSystemId(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
            <option value="">(none)</option>
            {systems.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </Field>
      </div>

      {error && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1 text-xs rounded border border-gray-200 bg-white hover:bg-gray-50 text-gray-700">Cancel</button>
        <button disabled={!canSubmit} onClick={submit} className="px-3 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50">
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, help, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700">{label}</label>
      {children}
      {help && <p className="text-[11px] text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white border border-gray-200 rounded-lg p-5 w-[480px] max-w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
