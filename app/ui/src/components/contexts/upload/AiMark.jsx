// A subtle mark on a field the AI chose (rather than the column-name rules).
// The analyst can change the field like any other; the mark only says where
// the suggestion came from.
export default function AiMark({ show }) {
  if (!show) return null;
  return (
    <span
      title="Suggested by the AI — change it if it is wrong"
      className="ml-1 rounded border border-gray-300 bg-gray-50 px-1 text-[10px] font-medium text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
    >
      AI
    </span>
  );
}
