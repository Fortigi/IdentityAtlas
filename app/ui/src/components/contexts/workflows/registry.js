// Action cards: the work that starts from a context.
//
// Which cards a context's Actions area holds is decided per template. A card is
// `{ key, Card, props?, analystOnly?, when? }`: a component taking { attrs,
// variants, variantsLoading, onOpenDetail } plus its own `props`; `when(attrs)`
// narrows a card to some contexts of the template. A template without a list
// (Tag, Segment, Other) shows no Actions area.
//
// The entitlement report is an application's: every entitlement the
// application holds and who holds it. An organisational unit (of people,
// accounts or resources) gets the matrix; a unit of accounts or people also
// gets the unit report (its members, their entitlement counts and attributes) —
// a unit of resources has no report card.
//
// `analystOnly`: left out of a read-only shared view (a context owner's page) —
// work only an analyst starts.

import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';

const VIEW_IN_MATRIX = { key: 'view-in-matrix', Card: MatrixCard };
const DOWNLOAD_REPORT = { key: 'download-report', Card: DownloadReportCard };
const DOWNLOAD_UNIT_REPORT = {
  key: 'download-unit-report',
  Card: DownloadReportCard,
  when: attrs => attrs.targetType === 'Principal' || attrs.targetType === 'Identity',
  props: {
    report: 'unit-members',
    title: 'Download unit report',
    text: 'Everyone in this unit with their details, how many entitlements each holds and every attribute, as a spreadsheet.',
    testId: 'action-download-unit-report',
  },
};

const ACTIONS = {
  OrganizationalUnit: [VIEW_IN_MATRIX, DOWNLOAD_UNIT_REPORT],
  LogicalApplication: [VIEW_IN_MATRIX, DOWNLOAD_REPORT],
};

/** The action cards this context shows, in order; `sharedView` drops the analyst-only ones. */
export function actionCardsFor(attrs, { sharedView = false } = {}) {
  const cards = (ACTIONS[attrs.contextCategory] || []).filter(c => !c.when || c.when(attrs));
  return sharedView ? cards.filter(c => !c.analystOnly) : cards;
}
