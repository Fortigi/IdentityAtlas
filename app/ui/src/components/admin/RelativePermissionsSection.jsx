import ContextOwnerAccessSection from './ContextOwnerAccessSection';

// Admin → Authentication → Authorization: relative permissions — access people
// get because of how they relate to the data (they answer for a context, a
// matrix was shared with them), not because they hold an Identity Atlas role.
// Two kinds today: context owners (the switch below) and matrix-share
// recipients, who have no setting of their own here.
// See docs/architecture/context-owner-access.md.
export default function RelativePermissionsSection() {
  return (
    <section aria-labelledby="relative-permissions-heading"
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <h3 className="text-base font-semibold text-gray-900 dark:text-white">Authorization</h3>
      <h4 id="relative-permissions-heading" className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">
        Relative permissions
      </h4>
      <p className="mt-1 mb-4 text-xs text-gray-600 dark:text-gray-400">
        Access people get because of how they relate to the data, rather than an Identity Atlas role. It is
        always read-only and limited to the data they relate to.
      </p>
      <ContextOwnerAccessSection />
      <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
        Matrix-share recipients are the other kind: someone a matrix is shared with can open that shared
        matrix without an Identity Atlas role. That is decided per share, by whoever shares it, and switched
        on under Admin → Experimental → Matrix sharing — there is no setting for it here.
      </p>
    </section>
  );
}
