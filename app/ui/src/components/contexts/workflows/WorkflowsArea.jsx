import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import { actionCardsFor } from './registry';

// The Actions area of a context's page: the cards its template gets (see
// registry.js), or nothing when there are none. A read-only shared view (a
// context owner's page) gets only the cards meant for its reader.
export default function WorkflowsArea({ attrs, ...cardProps }) {
  const cards = actionCardsFor(attrs, { sharedView: useIsSharedView() });
  if (cards.length === 0) return null;
  return (
    <section aria-label="Actions">
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Actions</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(({ key, Card, props }) => <Card key={key} attrs={attrs} {...cardProps} {...props} />)}
      </div>
    </section>
  );
}
