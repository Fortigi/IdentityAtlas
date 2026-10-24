import MatrixApBandCell from './MatrixApBandCell';

// The right-hand end of every grouping header row (rotated or cross table): the
// access-package colour bands (their labels live on the pinned names row so they
// stay visible) and the three metadata placeholders (# | Type | Description).
// Every header row must emit these so its width still matches a resource row.
export default function MatrixHeaderRowTail({ accessPackages = [], isDark }) {
  return (
    <>
      {accessPackages.map((ap, idx) => (
        <MatrixApBandCell key={ap.id} accessPackages={accessPackages} idx={idx} isDark={isDark} />
      ))}
      <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px' }} />
      <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '180px' }} />
      <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800" style={{ minWidth: '500px' }} />
    </>
  );
}
