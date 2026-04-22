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
    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

function LineChart({ data, maxValue, color, height = 60, label }) {
  if (!data || data.length === 0) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">
        Collecting data...
      </div>
    );
  }

  const width = 300;
  const padding = { top: 8, right: 8, bottom: 20, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const max = Math.max(maxValue || 100, ...data.map(d => d.value), 1);

  const points = data.map((d, i) => {
    const x = padding.left + (i / Math.max(data.length - 1, 1)) * chartWidth;
    const y = padding.top + chartHeight - (d.value / max) * chartHeight;
    return `${x},${y}`;
  }).join(' ');

  const gridLines = [];
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (i / 4) * chartHeight;
    const value = max * (1 - i / 4);
    gridLines.push({ y, value });
  }

  const timeLabels = [
    { x: padding.left, text: '-10m' },
    { x: padding.left + chartWidth / 2, text: '-5m' },
    { x: padding.left + chartWidth, text: 'now' },
  ];

  return (
    <div>
      <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</div>
      <svg width={width} height={height} className="border border-gray-200 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-800">
        {gridLines.map((line, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={line.y}
              x2={width - padding.right}
              y2={line.y}
              stroke="#374151"
              strokeWidth="1"
            />
            <text
              x={padding.left - 5}
              y={line.y + 3}
              textAnchor="end"
              className="text-[9px] fill-gray-500"
            >
              {line.value.toFixed(0)}
            </text>
          </g>
        ))}

        {timeLabels.map((tl, i) => (
          <text
            key={i}
            x={tl.x}
            y={height - 5}
            textAnchor={i === 0 ? 'start' : i === 1 ? 'middle' : 'end'}
            className="text-[9px] fill-gray-500"
          >
            {tl.text}
          </text>
        ))}

        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {data.length > 0 && (
          <circle
            cx={padding.left + ((data.length - 1) / Math.max(data.length - 1, 1)) * chartWidth}
            cy={padding.top + chartHeight - (data[data.length - 1].value / max) * chartHeight}
            r="3"
            fill={color}
          />
        )}
      </svg>
    </div>
  );
}

const SERVICE_LABELS = {
  web:      { label: 'Web (API + UI)',    icon: '🌐' },
  worker:   { label: 'Worker (Crawlers)', icon: '⚙️' },
  postgres: { label: 'PostgreSQL',        icon: '🗄️' },
};

const MAX_HISTORY_POINTS = 200;

export default function ContainerStatsPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const prevNet = useRef({});
  const prevTime = useRef(null);
  const [rates, setRates] = useState({});
  const [history, setHistory] = useState({});

  const fetchStats = async () => {
    try {
      const r = await authFetch('/api/admin/container-stats');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); setData(null); return; }
      setError(null);
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

      setHistory(prev => {
        const next = { ...prev };
        for (const c of j.containers) {
          if (!next[c.name]) next[c.name] = { cpu: [], memory: [], netRx: [], netTx: [] };
          const h = next[c.name];
          const rate = newRates[c.name] || {};

          h.cpu.push({ timestamp: now, value: c.cpuPercent || 0 });
          h.memory.push({ timestamp: now, value: c.memPercent || 0 });
          h.netRx.push({ timestamp: now, value: (rate.rxRate || 0) / 1024 / 1024 });
          h.netTx.push({ timestamp: now, value: (rate.txRate || 0) / 1024 / 1024 });

          if (h.cpu.length > MAX_HISTORY_POINTS) h.cpu.shift();
          if (h.memory.length > MAX_HISTORY_POINTS) h.memory.shift();
          if (h.netRx.length > MAX_HISTORY_POINTS) h.netRx.shift();
          if (h.netTx.length > MAX_HISTORY_POINTS) h.netTx.shift();
        }
        return next;
      });
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
      <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-300">
        <div className="font-semibold mb-1">Could not load container stats</div>
        <div>{error}</div>
        <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          The web container needs read-only access to the Docker socket. After updating docker-compose.yml, run:
          <code className="block mt-1 px-2 py-1 bg-amber-100 dark:bg-amber-900/40 rounded">docker compose up -d web</code>
        </div>
      </div>
    );
  }

  if (!data) return <div className="text-sm text-gray-500 dark:text-gray-400 p-4">Loading container stats…</div>;

  if (data.unavailable) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-300">
        <div className="font-semibold mb-1">Container stats unavailable</div>
        <div>The web container cannot access the Docker socket to read container metrics.</div>
        {data.reason && <div className="mt-1 font-mono text-xs bg-amber-100 dark:bg-amber-900/40 px-2 py-1 rounded">{data.reason}</div>}
        <div className="mt-3 text-xs text-amber-700 dark:text-amber-400 space-y-1">
          <p>To enable container monitoring, the Docker socket must be readable by the web container. Common fixes:</p>
          <ul className="list-disc list-inside ml-2 space-y-0.5">
            <li><strong>Linux:</strong> <code>sudo chmod 666 /var/run/docker.sock</code> (or add the container user to the <code>docker</code> group)</li>
            <li><strong>Docker Desktop (Windows/Mac):</strong> Usually works out of the box — restart Docker Desktop if needed</li>
          </ul>
          <p className="mt-2">This does not affect any other functionality — crawlers, sync, and the UI all work without container stats.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Auto-refreshing every 3s · Last update: {new Date(data.timestamp).toLocaleTimeString()}
      </div>
      {data.containers.map(c => {
        const meta = SERVICE_LABELS[c.service] || { label: c.service, icon: '📦' };
        const rate = rates[c.name] || {};
        const h = history[c.name] || { cpu: [], memory: [], netRx: [], netTx: [] };
        return (
          <div key={c.name} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                  <span className="mr-2">{meta.icon}</span>{meta.label}
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{c.name} · {c.status}</p>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                c.state === 'running'
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
              }`}>{c.state}</span>
            </div>
            {c.error ? (
              <div className="text-sm text-red-600 dark:text-red-400">Stats error: {c.error}</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                      <span>CPU</span>
                      <span className="font-mono font-medium text-gray-900 dark:text-white">{c.cpuPercent.toFixed(1)}%</span>
                    </div>
                    <Bar percent={c.cpuPercent} color={c.cpuPercent > 80 ? 'bg-red-500' : c.cpuPercent > 50 ? 'bg-amber-500' : 'bg-emerald-500'} />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                      <span>Memory</span>
                      <span className="font-mono font-medium text-gray-900 dark:text-white">{fmtBytes(c.memUsageBytes)} / {fmtBytes(c.memLimitBytes)} ({c.memPercent.toFixed(0)}%)</span>
                    </div>
                    <Bar percent={c.memPercent} color={c.memPercent > 80 ? 'bg-red-500' : c.memPercent > 50 ? 'bg-amber-500' : 'bg-blue-500'} />
                  </div>
                  <div>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">Network</div>
                    <div className="font-mono text-xs text-gray-900 dark:text-white">
                      ↓ {rate.rxRate != null ? `${fmtBytes(rate.rxRate)}/s` : '—'} <span className="text-gray-400 dark:text-gray-500">({fmtBytes(c.netRxBytes)} total)</span>
                    </div>
                    <div className="font-mono text-xs text-gray-900 dark:text-white">
                      ↑ {rate.txRate != null ? `${fmtBytes(rate.txRate)}/s` : '—'} <span className="text-gray-400 dark:text-gray-500">({fmtBytes(c.netTxBytes)} total)</span>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-gray-100 dark:border-gray-700">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <LineChart data={h.cpu} maxValue={100} color="#10b981" label="CPU % (last 10 min)" />
                    <LineChart data={h.memory} maxValue={100} color="#3b82f6" label="Memory % (last 10 min)" />
                    <LineChart data={h.netRx} maxValue={Math.max(1, ...h.netRx.map(d => d.value))} color="#8b5cf6" label="Network RX (MB/s)" />
                    <LineChart data={h.netTx} maxValue={Math.max(1, ...h.netTx.map(d => d.value))} color="#f59e0b" label="Network TX (MB/s)" />
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                  Processes: {c.pids}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
