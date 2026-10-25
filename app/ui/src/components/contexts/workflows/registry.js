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
// A read-only shared view (a context owner's page) leaves out two kinds of card:
// `analystOnly` — work only an analyst starts — and
// `inApp` — a card that opens a page of the app (the matrix), which that reader
// cannot reach. The report cards stay: the owner may export their own context.

import MatrixCard from './MatrixCard';
import DownloadReportCard from './DownloadReportCard';
import UploadInterviewCard from '@ui/components/contexts/interviews/UploadInterviewCard';
import SendSurveyCard from '@ui/components/contexts/surveys/SendSurveyCard';
import DoSurveyCard from '@ui/components/contexts/surveys/DoSurveyCard';
import RosterCard from '@ui/components/contexts/surveys/RosterCard';

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

// Uploading an interview is an analyst's move: a reader never sees transcripts
// or unreviewed claims (docs/architecture/context-interviews.md).
const UPLOAD_INTERVIEW = { key: 'upload-interview', Card: UploadInterviewCard, analystOnly: true };
// Sending a survey is the analyst's too; the recipient answers it from Surveys
// (docs/architecture/survey-templates.md).
const SEND_SURVEY = { key: 'send-survey', Card: SendSurveyCard, analystOnly: true };
// Doing one in place, for someone who holds a role here but is no analyst (an
// analyst does it from the card above): kept for the shared view, where the
// Accountable answers for themselves. The card asks the API whether to show.
const DO_SURVEY = { key: 'do-survey', Card: DoSurveyCard };
// The roster of a unit of people or accounts: what the claims say about each.
// Kept for the shared view — a manager sees their own team's roster.
const ROSTER = {
  key: 'roster',
  Card: RosterCard,
  when: attrs => attrs.targetType === 'Principal' || attrs.targetType === 'Identity',
};

const ACTIONS = {
  OrganizationalUnit: [VIEW_IN_MATRIX, DOWNLOAD_UNIT_REPORT, ROSTER, UPLOAD_INTERVIEW, SEND_SURVEY, DO_SURVEY],
  LogicalApplication: [VIEW_IN_MATRIX, DOWNLOAD_REPORT, UPLOAD_INTERVIEW, SEND_SURVEY, DO_SURVEY],
};

/** The action cards this context shows, in order; `sharedView` drops the analyst-only and in-app ones. */
export function actionCardsFor(attrs, { sharedView = false } = {}) {
  const cards = (ACTIONS[attrs.contextCategory] || []).filter(c => !c.when || c.when(attrs));
  return sharedView ? cards.filter(c => !c.analystOnly && !c.inApp) : cards;
}
