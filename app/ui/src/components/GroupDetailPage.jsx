import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, formatValue, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';

const HEADER_FIELDS = ['description', 'groupTypeCalculated'];
const HIDDEN_FIELDS = new Set(['displayName', ...HEADER_FIELDS, ...RISK_FIELDS, 'ValidFrom', 'ValidTo']);

export default function GroupDetailPage({ groupId, cachedData, onCacheData, onClose }) {
  const { authFetch } = useAuth();

  // Core data (fast — attributes, tags, counts)
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Lazy-loaded history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Fetch core data (attributes + tags + counts)
  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/group/${encodeURIComponent(groupId)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(groupId, 'group', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, authFetch, cachedData?.core, onCacheData]);

  // Lazy-load history
  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/group/${encodeURIComponent(groupId)}/history`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setHistory(d);
        onCacheData?.(groupId, 'group', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [groupId, authFetch, history, onCacheData]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => {
      if (!prev) loadHistory();
      return !prev;
    });
  }, [loadHistory]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading group details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading group</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, hasHistory } = data;
  const historyCount = history ? history.length : (hasHistory ? null : 1);
  const otherAttributes = [['id', attributes.id], ...Object.entries(attributes).filter(([k]) => !HIDDEN_FIELDS.has(k) && k !== 'id')];
  const entraUrl = `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(groupId)}`;

  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-lg font-bold">
              G
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
              {attributes.groupTypeCalculated && (
                <p className="text-sm text-gray-500">{attributes.groupTypeCalculated}</p>
              )}
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          {tags.length > 0 && (
            <div className="flex gap-1.5 mt-2">
              {tags.map(t => (
                <span key={t.id} className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                  style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
          <a href={entraUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-xs text-blue-600 hover:text-blue-800 hover:underline">
            Open in Entra ID
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
        <button onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
          title="Close tab">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Risk Assessment */}
      <RiskScoreSection attributes={attributes} entityType="group" entityId={groupId} authFetch={authFetch} />

      {/* Attributes - single column table */}
      <Section title="Attributes" count={otherAttributes.length}>
        <table className="w-full text-sm">
          <tbody>
            {otherAttributes.map(([key, val]) => (
              <tr key={key} className="border-b border-gray-50 last:border-b-0">
                <td className="py-1 pr-4 text-gray-500 whitespace-nowrap align-top">{friendlyLabel(key)}</td>
                <td className="py-1 text-gray-900 font-medium break-all">{formatValue(val)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Version History - collapsible, lazy-loaded */}
      <div className="mt-6">
        <CollapsibleSection
          title="Version History"
          count={historyCount}
          countLabel={historyCount === 1 ? 'version' : 'versions'}
          open={historyOpen}
          onToggle={toggleHistory}
          loading={historyLoading}
        >
          {historyDiffs.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No changes recorded</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium w-44">Date</th>
                  <th className="px-4 py-2 font-medium">Changes</th>
                </tr>
              </thead>
              <tbody>
                {historyDiffs.map((diff, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2 text-gray-600 text-xs align-top whitespace-nowrap">
                      {formatDate(diff.date)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col gap-1">
                        {diff.changes.map((c, j) => (
                          <div key={j} className="text-xs">
                            <span className="font-medium text-gray-700">{friendlyLabel(c.field)}</span>
                            <span className="text-gray-400 mx-1">:</span>
                            <span className="text-red-500 line-through mr-1">{c.from}</span>
                            <span className="text-gray-400 mr-1">&rarr;</span>
                            <span className="text-green-600">{c.to}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}

function Section({ title, count, children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        {title}
        {count != null && <span className="text-xs font-normal text-gray-400">({count})</span>}
      </h3>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, count, countLabel, open, onToggle, loading, children }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2 hover:text-gray-900"
      >
        <span className="text-xs">{open ? '\u25BC' : '\u25B6'}</span>
        {title}
        {count != null && (
          <span className="text-xs font-normal text-gray-400">
            ({count}{countLabel ? ` ${countLabel}` : ''})
          </span>
        )}
        {loading && <span className="text-xs text-gray-400 animate-pulse">Loading...</span>}
      </button>
      {open && !loading && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
}

