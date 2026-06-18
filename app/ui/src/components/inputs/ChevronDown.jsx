// Shared dropdown chevron icon. Single source of the "this is a dropdown" symbol,
// reused by Select and Combobox so every dropdown shows an identical indicator.
export default function ChevronDown({ className = '' }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 8l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
