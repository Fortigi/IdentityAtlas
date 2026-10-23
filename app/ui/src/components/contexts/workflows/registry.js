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
// a unit of resources has no report card. Announced as "Coming soon" until they
// are built (docs/architecture/ownership-survey.md): an application's ownership
// survey; a unit's manager survey and its member review.
//
// A read-only shared view (a context owner's page) leaves out two kinds of card:
// `analystOnly` — starting a survey is the analyst's move, not the owner's — and
// `inApp` — a card that opens a page of the app (the matrix), which that reader
// cannot reach. The report cards stay: the owner may export their own context.

import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import ComingSoonCard from './ComingSoonCard';
import UploadActivityCard from '@ui/components/contexts/activity/UploadActivityCard';

// inApp: the card opens a page of the app, which a read-only shell cannot reach.
const VIEW_IN_MATRIX = { key: 'view-in-matrix', Card: MatrixCard, inApp: true };
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

// Upload an activity export onto the context (also a root: rows land on its
// sub-units). The analyst's move: the card itself also needs data.write.contexts.
const UPLOAD_ACTIVITY = { key: 'upload-activity', Card: UploadActivityCard, analystOnly: true };

// A card for work announced but not built yet.
const comingSoon = (key, props) => ({ key, Card: ComingSoonCard, analystOnly: true, props: { ...props, testId: `action-${key}` } });

const OWNERSHIP_SURVEY = comingSoon('ownership-survey', {
  title: 'Start ownership survey',
  text: 'Ask the accountable owner to confirm they own this — or tell us who does — and check that the '
    + 'right responsible people and delegates are set.',
  button: 'Start survey',
});
const MANAGER_SURVEY = comingSoon('manager-survey', {
  title: 'Start manager survey',
  text: 'Ask the manager to confirm they lead this team — or tell us who does — and name any delegates who '
    + 'may manage it with them.',
  button: 'Start survey',
});
const MEMBER_REVIEW = comingSoon('review-members', {
  title: 'Review team members',
  text: 'Ask the accountable or responsible person to confirm the members of this team are right, and say '
    + 'who should be added or removed.',
  button: 'Start review',
});

const ACTIONS = {
  OrganizationalUnit: [VIEW_IN_MATRIX, DOWNLOAD_UNIT_REPORT, UPLOAD_ACTIVITY, MANAGER_SURVEY, MEMBER_REVIEW],
  LogicalApplication: [VIEW_IN_MATRIX, DOWNLOAD_REPORT, UPLOAD_ACTIVITY, OWNERSHIP_SURVEY],
};

/** The action cards this context shows, in order; `sharedView` drops the analyst-only and in-app ones. */
export function actionCardsFor(attrs, { sharedView = false } = {}) {
  const cards = (ACTIONS[attrs.contextCategory] || []).filter(c => !c.when || c.when(attrs));
  return sharedView ? cards.filter(c => !c.analystOnly && !c.inApp) : cards;
}
