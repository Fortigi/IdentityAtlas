// Card summary for a configured Azure RM crawler (Admin → Crawlers list).
export default function Summary({ cfg }) {
  if (!cfg) return null;
  const scope = cfg.managementGroupId
    ? `Management group ${cfg.managementGroupId}`
    : cfg.subscriptionIds?.length
      ? `${cfg.subscriptionIds.length} subscription(s)`
      : 'All accessible subscriptions';
  return (
    <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
      <div>Tenant ID: <span className="font-mono text-xs">{cfg.tenantId}</span></div>
      <div>Scope: {scope}</div>
      {cfg.includeResourceLevel && <div className="text-xs">Includes individual resources</div>}
    </div>
  );
}
