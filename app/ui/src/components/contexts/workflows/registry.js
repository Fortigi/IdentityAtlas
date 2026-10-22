// Action cards: the work that starts from a context.
//
// Which cards a context's Actions area holds is decided per template. A card is
// `{ key, Card, props?, analystOnly? }`: a component taking { attrs, variants,
// variantsLoading, onOpenDetail } plus its own `props`. A template without a
// list (Tag, Segment, Other) shows no Actions area.
//
// The entitlement report is an application's: every entitlement the
// application holds and who holds it. An organisational unit (of people,
// accounts or resources) gets the matrix. Both get the ownership survey, shown
// as "Coming soon" until it is built (docs/architecture/ownership-survey.md).
//
// `analystOnly`: left out of a read-only shared view (a context owner's page) —
// starting a survey is the analyst's move, not the owner's.

import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import ComingSoonCard from './ComingSoonCard';

const VIEW_IN_MATRIX = { key: 'view-in-matrix', Card: MatrixCard };
const DOWNLOAD_REPORT = { key: 'download-report', Card: DownloadReportCard };

const OWNERSHIP_SURVEY = {
  key: 'ownership-survey',
  Card: ComingSoonCard,
  analystOnly: true,
  props: {
    title: 'Start ownership survey',
    text: 'Ask the accountable owner to confirm they own this — or tell us who does — and check that the '
      + 'right responsible people and delegates are set.',
    button: 'Start survey',
    testId: 'action-ownership-survey',
  },
};

const ACTIONS = {
  OrganizationalUnit: [VIEW_IN_MATRIX, OWNERSHIP_SURVEY],
  LogicalApplication: [VIEW_IN_MATRIX, DOWNLOAD_REPORT, OWNERSHIP_SURVEY],
};

/** The action cards this context shows, in order; `sharedView` drops the analyst-only ones. */
export function actionCardsFor(attrs, { sharedView = false } = {}) {
  const cards = ACTIONS[attrs.contextCategory] || [];
  return sharedView ? cards.filter(c => !c.analystOnly) : cards;
}
