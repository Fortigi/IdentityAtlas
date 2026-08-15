import { formatDateOnly as formatDate } from '@ui/utils/formatters';
import { COMPLIANCE_STYLES } from '@ui/utils/accessPackageStyles';

// Tooltip text for a business role that has a compliance status.
function complianceTitle(ap) {
  switch (ap.complianceStatus) {
    case 'Missed':
      return `Review deadline passed ${ap.daysOverdue} day${ap.daysOverdue !== 1 ? 's' : ''} ago (was due ${formatDate(ap.reviewDeadline)}) — will reset at the next review cycle`;
    case 'Reviewed Late':
      return `Reviewed after deadline (${formatDate(ap.reviewDeadline)})`;
    case 'In Progress':
      return `Due ${formatDate(ap.reviewDeadline)}`;
    case 'Compliant':
      return `Completed on time (due ${formatDate(ap.reviewDeadline)})`;
    default:
      return '';
  }
}

// Secondary "Reviewer: …" line under a status badge.
function ReviewerInfoLine({ info }) {
  return (
    <div className="mt-0.5 text-gray-500 dark:text-gray-400 text-[11px] leading-tight" title={`Reviewer: ${info}`}>
      <span className="text-gray-600 dark:text-gray-500">Reviewer: </span>{info}
    </div>
  );
}

// Secondary "N reviews not done" line — self-guards on a positive count.
function MissedReviewsLine({ count }) {
  if (!(count > 0)) return null;
  const s = count !== 1 ? 's' : '';
  return (
    <div
      className="mt-0.5 text-orange-600 text-[11px] leading-tight font-medium"
      title={`${count} past review cycle${s} where no reviewer completed any decisions`}
    >
      {count} review{s} not done
    </div>
  );
}

// Review Status cell for the Business Roles list — one of four shapes depending
// on whether a status exists, there are assignments, or a review is configured.
export default function ComplianceStatusCell({ ap }) {
  if (ap.complianceStatus) {
    const showReviewer = ap.complianceStatus === 'Missed' || ap.complianceStatus === 'In Progress';
    return (
      <div>
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${COMPLIANCE_STYLES[ap.complianceStatus] || 'bg-gray-100 text-gray-600 border-gray-200'}`}
          title={complianceTitle(ap)}
        >
          {ap.complianceStatus}
          {ap.complianceStatus === 'Missed' && ap.daysOverdue > 0 && ` (${ap.daysOverdue}d ago)`}
        </span>
        {ap.reviewerInfo && showReviewer && <ReviewerInfoLine info={ap.reviewerInfo} />}
        <MissedReviewsLine count={ap.missedReviewsCount} />
      </div>
    );
  }

  if (ap.totalAssignments === 0) {
    return (
      <span
        className="text-gray-600 dark:text-gray-500 text-xs"
        title={ap.hasReviewConfigured
          ? 'Review is configured but there are no active assignments — nothing to review'
          : 'No active assignments'}
      >
        No assignments
      </span>
    );
  }

  if (ap.hasReviewConfigured) {
    return (
      <div>
        <span
          className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border bg-yellow-50 text-yellow-700 border-yellow-300"
          title="Certification is configured on the assignment policy but no review instance has been created yet"
        >
          Pending first review
        </span>
        {ap.reviewerInfo && <ReviewerInfoLine info={ap.reviewerInfo} />}
        <MissedReviewsLine count={ap.missedReviewsCount} />
      </div>
    );
  }

  return (
    <span
      className="text-gray-600 dark:text-gray-500 text-xs"
      title="No certification is configured on any assignment policy for this business role"
    >
      Not required
    </span>
  );
}
