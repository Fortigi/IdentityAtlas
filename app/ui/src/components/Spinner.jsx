// Shared inline spinner SVG (heroicons-style), drawn with currentColor so it
// follows the surrounding text colour in both themes. Size is passed via
// `className` (e.g. "h-4 w-4"); the animate-spin class is always applied.
export default function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
    </svg>
  );
}
