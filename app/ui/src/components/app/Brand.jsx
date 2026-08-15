// App header brand block — logo + product title. Theme-aware logo swap.
export default function Brand({ isDark }) {
  return (
    <div className="flex items-center gap-3">
      <img src={isDark ? '/logo-dark.png' : '/logo.png'} alt="Identity Atlas" className="h-10 w-10 rounded-lg" />
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Identity <span className="text-lime-700 dark:text-lime-400">Atlas</span></h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Universal authorization intelligence
        </p>
      </div>
    </div>
  );
}
