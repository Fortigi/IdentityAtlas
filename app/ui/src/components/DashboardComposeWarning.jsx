// Identity Atlas — "your docker-compose file is outdated" banner.
//
// Rendered above the dashboard grid; renders nothing unless the running image
// reports (via /api/version) that the user's compose file is behind the
// minimum it expects. Extracted from DashboardPage so the conditional and the
// version-field reads stay out of that component.

export default function ComposeFileWarning({ version }) {
  if (!version?.composeFileOutdated) return null;
  return (
    <div className="mb-6 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-4 text-sm">
      <div className="font-semibold text-amber-800 dark:text-amber-300 mb-1">Your docker-compose file is outdated</div>
      <p className="text-amber-700 dark:text-amber-400">
        The running image expects compose file version {version.minComposeFileVersion} but your file is version {version.composeFileVersion || 'unknown'}.
        Re-download the latest version to get new settings (volume mounts, security fixes, etc.):
      </p>
      <code className="block mt-2 px-3 py-2 bg-amber-100 dark:bg-amber-900/50 rounded text-xs font-mono text-amber-900 dark:text-amber-200">
        curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml
      </code>
    </div>
  );
}
