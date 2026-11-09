import ContextOwnerAccessSection from './ContextOwnerAccessSection';

// Admin → Roles & Permissions → Relative permissions (below the role table):
// access people get because of how they relate to the data (they answer for a
// context, a matrix was shared with them), not because they hold a role in the
// table above. Two kinds today: context owners (the switch below) and
// matrix-share recipients, who have no setting of their own here.
// See docs/architecture/context-owner-access.md.
export default function RelativePermissionsSection() {
  return (
    <section aria-labelledby="relative-permissions-heading"
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-6 my-6">
      <h3 id="relative-permissions-heading" className="font-semibold text-gray-900 dark:text-white">
        Relative permissions
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 mb-4">
        Access people get because of how they relate to the data, without holding one of the roles above.
        It is always read-only and limited to the data they relate to.
      </p>
      <ContextOwnerAccessSection />
      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        Matrix-share recipients are the other kind: someone a matrix is shared with can open that shared
        matrix without a role. That is decided per share, by whoever shares it (switched on under
        Admin → Experimental → Matrix sharing), so it has no setting here.
      </p>
    </section>
  );
}
