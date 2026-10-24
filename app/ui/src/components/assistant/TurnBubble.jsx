// One turn of a conversation with the local model: the analyst's message on the right,
// the model's reply on the left. Shared by the report builder's assistant and the context
// builder's — the markup was identical in both, which the duplication gate caught.

/**
 * @param {object} props
 * @param {'user'|'assistant'} props.role
 * @param {string} [props.text]      the analyst's message
 * @param {import('react').ReactNode} [props.children]  the model's reply
 */
export default function TurnBubble({ role, text, children }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-3xl rounded-lg bg-blue-50 px-3 py-2 text-sm text-gray-900 dark:bg-blue-900/30 dark:text-gray-100">{text}</p>
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700/50 dark:text-gray-100">
      {children}
    </div>
  );
}
