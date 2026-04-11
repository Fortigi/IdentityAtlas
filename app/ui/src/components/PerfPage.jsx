import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

function formatMs(ms) {
  if (ms == null) return '\u2014';
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  return ms.toFixed(1) + 'ms';
}

function durationColor(ms) {
  if (ms < 200) return 'text-green-600';
  if (ms < 1000) return 'text-yellow-600';
  if (ms < 5000) return 'text-orange-600';
  return 'text-red-600';
}

function durationBg(ms) {
  if (ms < 200) return 'bg-green-50';
  if (ms < 1000) return 'bg-yellow-50';
  if (ms < 5000) return 'bg-orange-50';
  return 'bg-red-50';
}

export default function PerfPage() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [recentData, setRecentData] = useState(null);
  const [slowData, setSlowData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('summary'); // 'summary' | 'recent' | 'slow'
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [summaryRes, recentRes, slowRes] = await Promise.all([
        authFetch('/api/perf').then(r => r.json()),
        authFetch('/api/perf/recent?n=100').then(r => r.json()),
        authFetch('/api/perf/slow?n=20').then(r => r.json()),
      ]);
      setSummary(summaryRes);
      setRecentData(recentRes);
      setSlowData(slowRes);
    } catch (err) {
      console.error('Failed to fetch performance metrics:', err);
      setSummary({ enabled: false });
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const handleExport = useCallback(async () => {
    try {
      const res = await authFetch('/api/perf/export');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `identity-atlas-perf-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Failed to export performance data:', err); }
  }, [authFetch]);

  const handleClear = useCallback(async () => {
    await authFetch('/api/perf/clear', { method: 'POST' });
    fetchData();
  }, [authFetch, fetchData]);

  const handleToggle = useCallback(async (target) => {
    await authFetch('/api/perf/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: target }),
    });
    fetchData();
  }, [authFetch, fetchData]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading performance metrics...</div>;
  }

  if (!summary?.enabled) {
    return (
      <div className="max-w-3xl mx-auto mt-8">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
          <h2 className="text-amber-800 font-semibold text-lg">Performance Monitoring Disabled</h2>
          <p className="text-amber-700 mt-2 text-sm">
            Performance monitoring captures high-resolution timing on each API request and SQL query,
            stored in a 1000-entry ring buffer. Server-Timing headers appear in browser DevTools.
            Adds minimal overhead — safe to enable in production.
          </p>
          <button
            onClick={() => handleToggle(true)}
            className="mt-4 px-4 py-2 bg-amber-600 text-white rounded text-sm font-medium hover:bg-amber-700"
          >
            Enable Performance Monitoring
          </button>
          <p className="text-amber-600 mt-3 text-xs">
            Toggling here is runtime-only and resets when the backend restarts.
            Set <code className="px-1 bg-amber-100 rounded">PERF_METRICS_ENABLED=true</code> in your environment for permanent activation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Performance Metrics</h2>
          <p className="text-sm text-gray-500">
            {summary.totalRecorded} requests recorded ({summary.bufferSize} in buffer)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300"
            />
            Auto-refresh (5s)
          </label>
          <button onClick={fetchData} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded border border-gray-300">
            Refresh
          </button>
          <button onClick={handleExport} className="px-3 py-1.5 text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200">
            Export JSON
          </button>
          <button onClick={handleClear} className="px-3 py-1.5 text-xs bg-red-50 hover:bg-red-100 text-red-700 rounded border border-red-200">
            Clear
          </button>
          <button onClick={() => handleToggle(false)} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded border border-gray-300" title="Disable performance monitoring">
            Disable
          </button>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {[
          { key: 'summary', label: 'Endpoint Summary' },
          { key: 'recent', label: 'Recent Requests' },
          { key: 'slow', label: 'Slowest Requests' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              view === tab.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {view === 'summary' && <EndpointSummary endpoints={summary.endpoints} />}
      {view === 'recent' && <RequestList entries={recentData?.data || []} />}
      {view === 'slow' && <RequestList entries={slowData?.data || []} />}

      {/* Tip */}
      <div className="mt-6 bg-gray-50 border border-gray-200 rounded-lg p-4 text-xs text-gray-500">
        <p className="font-medium text-gray-700 mb-1">Tips for analysis</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Check browser DevTools &rarr; Network tab &rarr; Timing section for <code className="bg-gray-200 px-1 rounded">Server-Timing</code> breakdown per request</li>
          <li>Use <strong>Export JSON</strong> to download all captured metrics and share them for detailed analysis</li>
          <li>SQL breakdown shows time per individual query &mdash; look for queries taking &gt; 1s</li>
          <li>The P95 column shows the duration that 95% of requests are faster than &mdash; useful for identifying intermittent slowness</li>
        </ul>
      </div>
    </div>
  );
}

function EndpointSummary({ endpoints }) {
  const [expanded, setExpanded] = useState(new Set());

  const toggle = (route) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(route)) next.delete(route);
      else next.add(route);
      return next;
    });
  };

  if (!endpoints?.length) {
    return <p className="text-sm text-gray-400 italic">No requests recorded yet. Use the application to generate metrics.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
            <th className="px-3 py-2 font-medium"></th>
            <th className="px-3 py-2 font-medium">Endpoint</th>
            <th className="px-3 py-2 font-medium text-right">Count</th>
            <th className="px-3 py-2 font-medium text-right">Avg</th>
            <th className="px-3 py-2 font-medium text-right">P50</th>
            <th className="px-3 py-2 font-medium text-right">P95</th>
            <th className="px-3 py-2 font-medium text-right">P99</th>
            <th className="px-3 py-2 font-medium text-right">Min</th>
            <th className="px-3 py-2 font-medium text-right">Max</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep) => {
            const key = `${ep.method} ${ep.route}`;
            const isOpen = expanded.has(key);
            const hasSql = ep.sqlBreakdown?.length > 0;
            return [
              <tr
                key={key}
                className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${durationBg(ep.p95)}`}
                onClick={() => hasSql && toggle(key)}
              >
                <td className="px-3 py-2 w-6 text-gray-400 text-xs">
                  {hasSql ? (isOpen ? '\u25BC' : '\u25B6') : ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span className="text-gray-400 mr-1">{ep.method}</span>
                  <span className="text-gray-800">{ep.route}</span>
                </td>
                <td className="px-3 py-2 text-right text-gray-600">{ep.count}</td>
                <td className={`px-3 py-2 text-right font-medium ${durationColor(ep.avg)}`}>{formatMs(ep.avg)}</td>
                <td className={`px-3 py-2 text-right ${durationColor(ep.p50)}`}>{formatMs(ep.p50)}</td>
                <td className={`px-3 py-2 text-right font-medium ${durationColor(ep.p95)}`}>{formatMs(ep.p95)}</td>
                <td className={`px-3 py-2 text-right ${durationColor(ep.p99)}`}>{formatMs(ep.p99)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{formatMs(ep.min)}</td>
                <td className={`px-3 py-2 text-right ${durationColor(ep.max)}`}>{formatMs(ep.max)}</td>
              </tr>,
              isOpen && ep.sqlBreakdown?.map((sq) => (
                <tr key={`${key}-${sq.label}`} className="border-b border-gray-50 bg-blue-50/30">
                  <td className="px-3 py-1.5"></td>
                  <td className="px-3 py-1.5 font-mono text-xs text-blue-700 pl-8">
                    SQL: {sq.label}
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-500 text-xs">{sq.count}x</td>
                  <td className={`px-3 py-1.5 text-right text-xs ${durationColor(sq.avg)}`}>{formatMs(sq.avg)}</td>
                  <td className={`px-3 py-1.5 text-right text-xs ${durationColor(sq.p50)}`}>{formatMs(sq.p50)}</td>
                  <td className={`px-3 py-1.5 text-right text-xs font-medium ${durationColor(sq.p95)}`}>{formatMs(sq.p95)}</td>
                  <td className="px-3 py-1.5"></td>
                  <td className="px-3 py-1.5"></td>
                  <td className={`px-3 py-1.5 text-right text-xs ${durationColor(sq.max)}`}>{formatMs(sq.max)}</td>
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function RequestList({ entries }) {
  const [expanded, setExpanded] = useState(new Set());

  const toggle = (idx) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (!entries?.length) {
    return <p className="text-sm text-gray-400 italic">No requests recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
            <th className="px-3 py-2 font-medium"></th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Endpoint</th>
            <th className="px-3 py-2 font-medium text-right">Status</th>
            <th className="px-3 py-2 font-medium text-right">Total</th>
            <th className="px-3 py-2 font-medium text-right">SQL</th>
            <th className="px-3 py-2 font-medium text-right">Queries</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, idx) => {
            const isOpen = expanded.has(idx);
            const hasSql = entry.sqlQueries?.length > 0;
            return [
              <tr
                key={idx}
                className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${durationBg(entry.totalMs)}`}
                onClick={() => hasSql && toggle(idx)}
              >
                <td className="px-3 py-2 w-6 text-gray-400 text-xs">
                  {hasSql ? (isOpen ? '\u25BC' : '\u25B6') : ''}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span className="text-gray-400 mr-1">{entry.method}</span>
                  <span className="text-gray-800 break-all">{entry.url || entry.route}</span>
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={`text-xs font-medium ${entry.statusCode < 400 ? 'text-green-600' : 'text-red-600'}`}>
                    {entry.statusCode}
                  </span>
                </td>
                <td className={`px-3 py-2 text-right font-medium ${durationColor(entry.totalMs)}`}>
                  {formatMs(entry.totalMs)}
                </td>
                <td className={`px-3 py-2 text-right ${durationColor(entry.sqlTotalMs)}`}>
                  {entry.sqlTotalMs ? formatMs(entry.sqlTotalMs) : '\u2014'}
                </td>
                <td className="px-3 py-2 text-right text-gray-500">
                  {entry.sqlQueryCount || 0}
                </td>
              </tr>,
              isOpen && entry.sqlQueries?.map((sq, sqIdx) => (
                <tr key={`${idx}-${sqIdx}`} className="border-b border-gray-50 bg-blue-50/30">
                  <td className="px-3 py-1"></td>
                  <td className="px-3 py-1"></td>
                  <td className="px-3 py-1 font-mono text-xs text-blue-700 pl-8">
                    {sq.label}
                    {sq.rows != null && <span className="text-gray-400 ml-2">({sq.rows} rows)</span>}
                    {sq.error && <span className="text-red-500 ml-2">{sq.error}</span>}
                  </td>
                  <td className="px-3 py-1"></td>
                  <td className={`px-3 py-1 text-right text-xs font-medium ${durationColor(sq.ms)}`}>
                    {formatMs(sq.ms)}
                  </td>
                  <td className="px-3 py-1"></td>
                  <td className="px-3 py-1"></td>
                </tr>
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
