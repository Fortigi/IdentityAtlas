// Friendly terminal states for a share link that can't be opened (#1166).
//
// The recipient is a business user who was simply sent a link — a revoked,
// unknown or broken share must read as a plain sentence, never an error dump
// or a status code. There is deliberately no action button: there is nothing
// useful for them to do here except close the tab and ask the sender.

const MESSAGES = {
  revoked: {
    title: 'This view is no longer shared',
    hint: 'The person who shared this matrix has since revoked the link. Ask them to share it again if you still need it.',
  },
  missing: {
    title: 'This link doesn’t open a shared view',
    hint: 'The link may be incomplete or may have been replaced. Check that you copied all of it, or ask the sender for a fresh link.',
  },
  error: {
    title: 'This view couldn’t be opened',
    hint: 'Something went wrong loading the shared matrix. Try again in a moment, or let the sender know if it keeps happening.',
  },
};

export default function SharedMatrixUnavailable({ status }) {
  const { title, hint } = MESSAGES[status] || MESSAGES.error;
  return (
    <main id="main-content" className="p-6">
      <div className="mx-auto mt-10 max-w-lg rounded-lg border border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
        <img src="/logo.png" alt="" aria-hidden="true" className="mx-auto mb-4 h-12 w-12 rounded-lg dark:hidden" />
        <img src="/logo-dark.png" alt="" aria-hidden="true" className="mx-auto mb-4 hidden h-12 w-12 rounded-lg dark:block" />
        <h1 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">{hint}</p>
      </div>
    </main>
  );
}
