// What a matrix with nothing in it says.
//
// "No assignments match" is true but unhelpful when the reason is that a
// context the matrix filters on has been deleted: the API drops that condition
// and runs the matrix anyway, so what comes back is not the matrix that was
// saved. One component for all three views, so a matrix that broke explains
// itself the same way whichever way round it is being read.

import { brokenMatrixExplanation } from './matrixHealth';

export default function MatrixEmptyState({ message, missingContextIds }) {
  const explanation = brokenMatrixExplanation(missingContextIds);
  return (
    <div className="py-12 text-center text-gray-500 dark:text-gray-400">
      <p>{message}</p>
      {explanation && (
        <p className="mx-auto mt-3 max-w-xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {explanation}
        </p>
      )}
    </div>
  );
}
