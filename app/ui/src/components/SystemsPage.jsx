import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function parseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

export default function SystemsPage() {
  const { authFetch } = useAuth();
  const [systems, setSystems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const fetchSystems = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch('/api/systems');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSystems(Array.isArray(data) ? data : data.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchSystems(); }, [fetchSystems]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading systems...</div>;
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-red-800 font-semibold">Error loading systems</h2>
          <p className="text-red-600 mt-1 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Systems</h2>
        <span className="text-sm text-gray-500">{systems.length} connected</span>
      </div>

      {systems.length === 0 ? (
        <div className="text-center text-gray-500 py-12">
          No systems configured. Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm">Start-FGSync</code> to sync data and register systems.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2">
          {systems.map(sys => {
            const isExpanded = expandedId === sys.id;
            const resourceTypes = parseJsonArray(sys.computedResourceTypes || sys.resourceTypes);
            const assignmentTypes = parseJsonArray(sys.computedAssignmentTypes || sys.assignmentTypes);
            const owners = parseJsonArray(sys.owners);
            const enabled = sys.enabled !== false && sys.enabled !== 0;

            return (
              <div
                key={sys.id}
                className={`bg-white border rounded-lg shadow-sm transition-shadow hover:shadow-md ${
                  isExpanded ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'
                }`}
              >
                {/* Card header */}
                <div
                  className="px-5 py-4 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : sys.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {(sys.systemType || 'S')[0].toUpperCase()}
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">{sys.displayName || sys.id}</h3>
                        <p className="text-xs text-gray-500">Type: {sys.systemType || 'Unknown'}</p>
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      enabled
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-700'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-green-500' : 'bg-red-500'}`} />
                      {enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-4 mt-3 text-xs text-gray-600">
                    <span>
                      <span className="font-medium text-gray-900">{(sys.principalCount || 0).toLocaleString()}</span> Users
                    </span>
                    <span>
                      <span className="font-medium text-gray-900">{(sys.resourceCount || 0).toLocaleString()}</span> Resources
                    </span>
                    <span>
                      <span className="font-medium text-gray-900">{(sys.assignmentCount || 0).toLocaleString()}</span> Assignments
                    </span>
                    <span className="ml-auto text-gray-400">
                      Last sync: {formatRelativeTime(sys.lastSyncTime)}
                    </span>
                  </div>

                  {/* Resource types */}
                  {resourceTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {resourceTypes.map(rt => (
                        <span key={rt} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200">
                          {rt}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Owners */}
                  {owners.length > 0 && (
                    <div className="text-xs text-gray-500 mt-2">
                      Owners: {owners.join(', ')}
                    </div>
                  )}
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-5 py-4 bg-gray-50/50">
                    {sys.description && (
                      <div className="mb-3">
                        <p className="text-xs font-medium text-gray-500">Description</p>
                        <p className="text-sm text-gray-700 mt-0.5">{sys.description}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="font-medium text-gray-500">System ID</p>
                        <p className="text-gray-700 mt-0.5 font-mono text-[11px] break-all">{sys.id}</p>
                      </div>
                      <div>
                        <p className="font-medium text-gray-500">System Type</p>
                        <p className="text-gray-700 mt-0.5">{sys.systemType || 'Unknown'}</p>
                      </div>
                      {sys.tenantId && (
                        <div>
                          <p className="font-medium text-gray-500">Tenant ID</p>
                          <p className="text-gray-700 mt-0.5 font-mono text-[11px] break-all">{sys.tenantId}</p>
                        </div>
                      )}
                      {sys.connectionInfo && (
                        <div>
                          <p className="font-medium text-gray-500">Connection Info</p>
                          <p className="text-gray-700 mt-0.5">{sys.connectionInfo}</p>
                        </div>
                      )}
                    </div>

                    {assignmentTypes.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-gray-500 mb-1">Assignment Types</p>
                        <div className="flex flex-wrap gap-1">
                          {assignmentTypes.map(at => (
                            <span key={at} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                              {at}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {sys.createdAt && (
                      <div className="mt-3 text-xs text-gray-400">
                        Created: {new Date(sys.createdAt).toLocaleString()}
                        {sys.updatedAt && ` | Updated: ${new Date(sys.updatedAt).toLocaleString()}`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
