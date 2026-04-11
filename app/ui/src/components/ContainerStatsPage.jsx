import { useEffect, useState, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function Bar({ percent, color }) {
  const p = Math.max(0, Math.min(100, percent || 0));
  return (
    <div className="w-full h-2 bg-gray-200 rounded overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

const SERVICE_LABELS = {
  web:      { label: 'Web (API + UI)',    icon: '🌐' },
  worker:   { label: 'Worker (Crawlers)', icon: '⚙️' },
  postgres: { label: 'PostgreSQL',        icon: '🗄️' },
};

export default function ContainerStatsPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const prevNet = useRef({});
  const prevTime = useRef(null);
  const [rates, setRates] = useState({});

  const fetchStats = async () => {
    try {
      const r = await authFetch('/api/admin/container-stats');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); setData(null); return; }
      setError(null);
      // Compute network rate (bytes/sec) by diffing with previous sample
      const now = Date.now();
      const newRates = {};
      if (prevTime.current) {
        const dt = (now - prevTime.current) / 1000;
        for (const c of j.containers) {
          const p = prevNet.current[c.name];
          if (p && dt > 0) {
            newRates[c.name] = {
              rxRate: Math.max(0, (c.netRxBytes - p.rx) / dt),
              txRate: Math.max(0, (c.netTxBytes - p.tx) / dt),
            };
          }
        }
      }
      const np = {};
      for (const c of j.containers) np[c.name] = { rx: c.netRxBytes, tx: c.netTxBytes };
      prevNet.current = np;
      prevTime.current = now;
      setRates(newRates);
      setData(j);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 3000);
    return () => clearInterval(id);
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <div className="font-semibold mb-1">Could not load container stats</div>
        <div>{error}</div>
        <div className="mt-2 text-xs text-amber-700">
          The web container needs read-only access to the Docker socket. After updating docker-compose.yml, run:
          <code className="block mt-1 px-2 py-1 bg-amber-100 rounded">docker compose up -d web</code>
        </div>
      </div>
    );
  }

  if (!data) return <div className="text-sm text-gray-500 p-4">Loading container stats…</div>;

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500">
        Auto-refreshing every 3s · Last update: {new Date(data.timestamp).toLocaleTimeString()}
      </div>
      {data.containers.map(c => {
        const meta = SERVICE_LABELS[c.service] || { label: c.service, icon: '📦' };
        const rate = rates[c.name] || {};
        return (
          <div key={c.name} className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900">
                  <span className="mr-2">{meta.icon}</span>{meta.label}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">{c.name} · {c.status}</p>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                c.state === 'running' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
              }`}>{c.state}</span>
            </div>
            {c.error ? (
              <div className="text-sm text-red-600">Stats error: {c.error}</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <div className="flex justify-between text-xs text-gray-600 mb-1">
                    <span>CPU</span>
                    <span className="font-mono font-medium text-gray-900">{c.cpuPercent.toFixed(1)}%</span>
                  </div>
                  <Bar percent={c.cpuPercent} color={c.cpuPercent > 80 ? 'bg-red-500' : c.cpuPercent > 50 ? 'bg-amber-500' : 'bg-emerald-500'} />
                </div>
                <div>
                  <div className="flex justify-between text-xs text-gray-600 mb-1">
                    <span>Memory</span>
                    <span className="font-mono font-medium text-gray-900">{fmtBytes(c.memUsageBytes)} / {fmtBytes(c.memLimitBytes)} ({c.memPercent.toFixed(0)}%)</span>
                  </div>
                  <Bar percent={c.memPercent} color={c.memPercent > 80 ? 'bg-red-500' : c.memPercent > 50 ? 'bg-amber-500' : 'bg-blue-500'} />
                </div>
                <div>
                  <div className="text-xs text-gray-600 mb-1">Network</div>
                  <div className="font-mono text-xs text-gray-900">
                    ↓ {rate.rxRate != null ? `${fmtBytes(rate.rxRate)}/s` : '—'} <span className="text-gray-400">({fmtBytes(c.netRxBytes)} total)</span>
                  </div>
                  <div className="font-mono text-xs text-gray-900">
                    ↑ {rate.txRate != null ? `${fmtBytes(rate.txRate)}/s` : '—'} <span className="text-gray-400">({fmtBytes(c.netTxBytes)} total)</span>
                  </div>
                </div>
              </div>
            )}
            {!c.error && (
              <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
                Processes: {c.pids}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
