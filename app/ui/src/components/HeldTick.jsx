// A blue tick in a circle: "holds this" in a matrix. The label says who holds
// what, for screen readers and as a tooltip. Used by the application context's
// role matrix and the unit team overview.
export default function HeldTick({ label }) {
  return (
    <span role="img" aria-label={label} title={label}
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
      <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 10.500l4 4 8-9" />
      </svg>
    </span>
  );
}
