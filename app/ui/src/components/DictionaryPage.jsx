import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const styles = {
    approved: 'bg-green-100 text-green-700',
    pending:  'bg-yellow-100 text-yellow-700',
    rejected: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}

function StrengthBar({ value }) {
  const pct = Math.round((value ?? 0) * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-400' : 'bg-gray-300';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs text-gray-500">{pct}%</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4 text-indigo-600" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

// ─── Create term modal ────────────────────────────────────────────────────────

function CreateTermModal({ onClose, onCreated, authFetch }) {
  const [term, setTerm]             = useState('');
  const [description, setDesc]      = useState('');
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState(null);

  const save = async () => {
    if (!term.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/dictionary/terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: term.trim(), description: description.trim() || null, status: 'pending' }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || 'Failed to create term'); return; }
      onCreated(j);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Add term</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Term *</label>
            <input
              type="text" value={term} onChange={e => setTerm(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. INK or procurement"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Description <span className="text-gray-400">(optional — LLM can fill this in)</span></label>
            <textarea
              value={description} onChange={e => setDesc(e.target.value)} rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              placeholder="What does this term mean in an authorization context?"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button
            onClick={save} disabled={!term.trim() || saving}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Spinner />} Add term
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Correlation row ──────────────────────────────────────────────────────────

function CorrelationRow({ corr, onApprove, onReject, onDelete }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-medium text-sm text-gray-900 truncate">{corr.relatedTerm}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${corr.correlationType === 'synonym' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-600'}`}>
          {corr.correlationType}
        </span>
        <StrengthBar value={corr.strength} />
        <StatusBadge status={corr.status} />
      </div>
      <div className="flex items-center gap-1 ml-2 shrink-0">
        {corr.status === 'pending' && (
          <>
            <button onClick={() => onApprove(corr.id)} className="text-xs text-green-600 hover:text-green-800 px-2 py-0.5 rounded hover:bg-green-50">✓</button>
            <button onClick={() => onReject(corr.id)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded hover:bg-gray-100">✕</button>
          </>
        )}
        <button onClick={() => onDelete(corr.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-0.5 rounded hover:bg-red-50">del</button>
      </div>
    </div>
  );
}

// ─── Classifier link row ──────────────────────────────────────────────────────

function ClassifierLinkRow({ link, onApprove, onReject }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-100 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm text-gray-900 truncate">{link.classifierLabel}</span>
          {link.classifierDomain && (
            <span className="text-xs text-gray-400 truncate">{link.classifierDomain}</span>
          )}
          <StatusBadge status={link.status} />
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          {link.status === 'pending' && (
            <>
              <button onClick={() => onApprove(link.id)} className="text-xs text-green-600 hover:text-green-800 px-2 py-0.5 rounded hover:bg-green-50">✓ Accept</button>
              <button onClick={() => onReject(link.id)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-0.5 rounded hover:bg-gray-100">✕ Reject</button>
            </>
          )}
          <button onClick={() => setOpen(o => !o)} className="text-xs text-indigo-500 hover:text-indigo-700 px-2 py-0.5 rounded hover:bg-indigo-50">
            {open ? 'Hide' : 'Patterns'}
          </button>
        </div>
      </div>
      {open && (
        <div className="space-y-1 pt-1">
          {(link.proposedPatterns || []).map((p, i) => (
            <code key={i} className="block text-xs bg-gray-900 text-green-300 px-2 py-0.5 rounded">{p}</code>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Term card (expandable) ───────────────────────────────────────────────────

function TermCard({ term, onStatusChange, onDelete, onRefresh, authFetch }) {
  const [open, setOpen]           = useState(false);
  const [detail, setDetail]       = useState(null);
  const [loadingDetail, setLD]    = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [correlating, setCorr]    = useState(false);
  const [actionMsg, setMsg]       = useState(null);

  const loadDetail = useCallback(async () => {
    setLD(true);
    try {
      const r = await authFetch(`/api/admin/dictionary/terms/${term.id}`);
      if (r.ok) setDetail(await r.json());
    } finally {
      setLD(false);
    }
  }, [term.id, authFetch]);

  const toggle = () => {
    if (!open) loadDetail();
    setOpen(o => !o);
  };

  const flash = (msg, ms = 3000) => {
    setMsg(msg);
    setTimeout(() => setMsg(null), ms);
  };

  const enrich = async () => {
    setEnriching(true);
    setMsg(null);
    try {
      const r = await authFetch('/api/admin/dictionary/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termId: term.id }),
      });
      const j = await r.json();
      if (!r.ok) { flash(`Error: ${j.error}`); return; }
      flash(`Enriched — ${j.classifierLinks?.length || 0} classifier proposal(s)`);
      loadDetail();
      onRefresh();
    } finally {
      setEnriching(false);
    }
  };

  const correlate = async () => {
    setCorr(true);
    setMsg(null);
    try {
      const r = await authFetch('/api/admin/dictionary/correlate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termId: term.id }),
      });
      const j = await r.json();
      if (!r.ok) { flash(`Error: ${j.error}`); return; }
      flash(`${j.proposals?.length || 0} correlation proposal(s) added`);
      loadDetail();
    } finally {
      setCorr(false);
    }
  };

  const updateCorrStatus = async (id, status) => {
    await authFetch(`/api/admin/dictionary/correlations/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadDetail();
  };

  const deleteCorr = async (id) => {
    await authFetch(`/api/admin/dictionary/correlations/${id}`, { method: 'DELETE' });
    loadDetail();
  };

  const updateLinkStatus = async (id, status) => {
    await authFetch(`/api/admin/dictionary/classifier-links/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    loadDetail();
    onRefresh();
  };

  const pendingLinks = parseInt(term.pendingLinks ?? 0, 10);
  const corrCount    = parseInt(term.correlationCount ?? 0, 10);

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={toggle} className="flex items-center gap-3 text-left flex-1 min-w-0">
          <svg className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-mono font-semibold text-gray-900 shrink-0">{term.term}</span>
          <StatusBadge status={term.status} />
          {corrCount > 0 && (
            <span className="text-xs text-gray-400">{corrCount} correlation{corrCount !== 1 ? 's' : ''}</span>
          )}
          {pendingLinks > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700">
              {pendingLinks} pending
            </span>
          )}
          {term.description && (
            <span className="text-sm text-gray-500 truncate">{term.description}</span>
          )}
        </button>

        <div className="flex items-center gap-1 ml-3 shrink-0">
          {term.status === 'pending' && (
            <>
              <button
                onClick={() => onStatusChange(term.id, 'approved')}
                className="text-xs text-green-600 hover:text-green-800 px-2 py-1 rounded hover:bg-green-50"
              >✓ Approve</button>
              <button
                onClick={() => onStatusChange(term.id, 'rejected')}
                className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
              >✕ Reject</button>
            </>
          )}
          <button
            onClick={() => onDelete(term.id)}
            className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
          >Delete</button>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
          {loadingDetail && <div className="flex items-center gap-2 text-sm text-gray-400"><Spinner /> Loading…</div>}

          {detail && (
            <>
              {/* Actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={enrich} disabled={enriching}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
                >
                  {enriching ? <Spinner /> : '✨'} Enrich with LLM
                </button>
                <button
                  onClick={correlate} disabled={correlating}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
                >
                  {correlating ? <Spinner /> : '🔗'} Suggest correlations
                </button>
                {actionMsg && <span className="text-xs text-gray-500">{actionMsg}</span>}
              </div>

              {/* Description */}
              {detail.description && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Description</p>
                  <p className="text-sm text-gray-700">{detail.description}</p>
                </div>
              )}

              {/* Business processes */}
              {detail.businessProcesses?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Business processes</p>
                  <div className="flex flex-wrap gap-1">
                    {detail.businessProcesses.map((bp, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs bg-blue-50 text-blue-700 rounded-full">{bp}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Correlations */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Correlations
                  {detail.correlations?.length > 0 && <span className="ml-1 text-gray-400">({detail.correlations.length})</span>}
                </p>
                {detail.correlations?.length > 0 ? (
                  <div>
                    {detail.correlations.map(c => (
                      <CorrelationRow
                        key={c.id}
                        corr={c}
                        onApprove={id => updateCorrStatus(id, 'approved')}
                        onReject={id => updateCorrStatus(id, 'rejected')}
                        onDelete={deleteCorr}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">None — click "Suggest correlations" to let the LLM propose relationships.</p>
                )}
              </div>

              {/* Classifier links */}
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Classifier links
                  {detail.classifierLinks?.length > 0 && <span className="ml-1 text-gray-400">({detail.classifierLinks.length})</span>}
                </p>
                {detail.classifierLinks?.length > 0 ? (
                  <div className="space-y-2">
                    {detail.classifierLinks.map(l => (
                      <ClassifierLinkRow
                        key={l.id}
                        link={l}
                        onApprove={id => updateLinkStatus(id, 'approved')}
                        onReject={id => updateLinkStatus(id, 'rejected')}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">None — click "Enrich with LLM" to analyse which classifiers this term relates to.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DictionaryPage() {
  const { authFetch } = useAuth();

  const [terms, setTerms]         = useState([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [q, setQ]                 = useState('');
  const [statusFilter, setStatus] = useState('');
  const [offset, setOffset]       = useState(0);
  const [showCreate, setCreate]   = useState(false);
  const [mining, setMining]       = useState(false);
  const [mineMsg, setMineMsg]     = useState(null);
  const [summary, setSummary]     = useState({ pendingTerms: 0, pendingCorrelations: 0, unappliedLinks: 0 });
  const [applying, setApplying]   = useState(false);
  const [applyMsg, setApplyMsg]   = useState(null);

  const LIMIT = 50;

  const loadSummary = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/dictionary/summary');
      if (r.ok) setSummary(await r.json());
    } catch { /* non-critical */ }
  }, [authFetch]);

  const load = useCallback(async (search = q, st = statusFilter, off = offset) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off });
      if (search) params.set('q', search);
      if (st)     params.set('status', st);
      const r = await authFetch(`/api/admin/dictionary/terms?${params}`);
      if (r.ok) {
        const j = await r.json();
        setTerms(j.terms || []);
        setTotal(j.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [authFetch, q, statusFilter, offset]);

  useEffect(() => { load(); loadSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = (val) => { setQ(val); setOffset(0); load(val, statusFilter, 0); };
  const filterStatus = (val) => { setStatus(val); setOffset(0); load(q, val, 0); };
  const prev = () => { const o = Math.max(0, offset - LIMIT); setOffset(o); load(q, statusFilter, o); };
  const next = () => { const o = offset + LIMIT; setOffset(o); load(q, statusFilter, o); };

  const mine = async () => {
    setMining(true);
    setMineMsg(null);
    try {
      const r = await authFetch('/api/admin/dictionary/mine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      });
      const j = await r.json();
      if (!r.ok) { setMineMsg(`Error: ${j.error}`); return; }
      setMineMsg(`Added ${j.added} new term${j.added !== 1 ? 's' : ''} from ${j.namesScanned} names`);
      load(q, statusFilter, 0);
      loadSummary();
    } finally {
      setMining(false);
    }
  };

  const applyLinks = async () => {
    setApplying(true);
    setApplyMsg(null);
    try {
      const r = await authFetch('/api/admin/dictionary/apply-classifier-links', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { setApplyMsg({ ok: false, text: j.error || 'Apply failed' }); return; }
      if (j.appliedCount === 0) {
        setApplyMsg({ ok: true, text: j.message || 'Nothing new to apply.' });
      } else {
        setApplyMsg({
          ok: true,
          text: `Applied ${j.appliedCount} classifier link${j.appliedCount !== 1 ? 's' : ''} → new classifier version #${j.newClassifierId}. Run risk scoring to see updated scores.`,
        });
      }
      loadSummary();
      load();
    } finally {
      setApplying(false);
    }
  };

  const handleStatusChange = async (id, status) => {
    await authFetch(`/api/admin/dictionary/terms/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    load();
    loadSummary();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this term and all its correlations?')) return;
    await authFetch(`/api/admin/dictionary/terms/${id}`, { method: 'DELETE' });
    load();
    loadSummary();
  };

  const pendingCount = terms.filter(t => t.status === 'pending').length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3">
        <input
          type="text" value={q} onChange={e => search(e.target.value)}
          placeholder="Search terms…"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48"
        />
        <select
          value={statusFilter} onChange={e => filterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>

        <div className="flex-1" />

        {pendingCount > 0 && (
          <span className="text-xs text-yellow-700 bg-yellow-50 px-2 py-1 rounded-full">
            {pendingCount} pending on this page
          </span>
        )}

        {summary.unappliedLinks > 0 && (
          <button
            onClick={applyLinks} disabled={applying}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {applying ? <Spinner /> : '⚡'} Apply {summary.unappliedLinks} link{summary.unappliedLinks !== 1 ? 's' : ''} to classifier
          </button>
        )}

        <button
          onClick={mine} disabled={mining}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
        >
          {mining ? <Spinner /> : '⛏'} Mine from data
        </button>

        <button
          onClick={() => setCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          + Add term
        </button>
      </div>

      {applyMsg && (
        <div className={`text-sm rounded-lg px-4 py-3 border ${applyMsg.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {applyMsg.text}
        </div>
      )}

      {mineMsg && (
        <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2">
          {mineMsg}
        </div>
      )}

      {/* Term list */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-gray-400">
          <Spinner /> Loading…
        </div>
      ) : terms.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-6 py-12 text-center">
          <p className="text-gray-500 text-sm mb-3">
            {q || statusFilter ? 'No terms match this filter.' : 'No terms yet.'}
          </p>
          <p className="text-gray-400 text-xs">
            Click <strong>Mine from data</strong> to auto-discover terms from resource names, or <strong>Add term</strong> to add one manually.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {terms.map(t => (
            <TermCard
              key={t.id}
              term={t}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onRefresh={() => load()}
              authFetch={authFetch}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > LIMIT && (
        <div className="flex items-center justify-between text-sm text-gray-500 px-1">
          <span>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
          <div className="flex gap-2">
            <button onClick={prev} disabled={offset === 0} className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">← Prev</button>
            <button onClick={next} disabled={offset + LIMIT >= total} className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40">Next →</button>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateTermModal
          authFetch={authFetch}
          onClose={() => setCreate(false)}
          onCreated={() => load()}
        />
      )}
    </div>
  );
}
