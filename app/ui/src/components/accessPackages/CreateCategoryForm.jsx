import { TAG_COLORS } from '@ui/utils/colors';

// Inline create-category form: name input, colour swatches, Create / Cancel.
export default function CreateCategoryForm({ name, setName, color, setColor, onCreate, onCancel, busy }) {
  return (
    <div className="flex items-center gap-2 mb-3 p-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && onCreate()}
        placeholder="Category name..."
        className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm w-48 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
        autoFocus
      />
      <div className="flex items-center gap-1">
        {TAG_COLORS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-5 h-5 rounded-full border-2 ${color === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <button
        onClick={onCreate}
        disabled={!name.trim() || busy}
        className="px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
      >
        Create
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        Cancel
      </button>
    </div>
  );
}
