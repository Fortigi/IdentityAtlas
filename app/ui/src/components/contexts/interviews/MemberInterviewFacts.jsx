import { useContextClaims } from './claimsContext';
import { factClass, factTitle, leftFlagText, rejoinedText, rejoinedTitle, roleTitle } from './memberInterview.helpers';

// ─── What the interviews say about a member, in a members list ────────────
// InterviewRole: the person's latest role at the context (the history in the
// tooltip). InterviewRejoinedFlag: "rejoined · earlier: Junior developer" on a
// member who left once and came back (the quote and the earlier periods as
// tooltip). InterviewLeftFlag: "Interview: left (…)" on a current member an
// interview says left, the quote as tooltip. A proposed claim reads dashed and
// italic, a confirmed one plain — knowledge, not a change to the members.
// For an analyst both open the transcript at the claim's quote; for a reader
// (or outside a ClaimsProvider) they are text. The row opens the member, so a
// click here stops at the button.

function ClaimText({ fact, title, className, children, testId }) {
  const open = useContextClaims()?.openTranscript;
  const classes = `${className} ${factClass(fact.status)}`;
  if (!open) return <span className={classes} title={title} data-testid={testId}>{children}</span>;
  return (
    <button type="button" title={title} data-testid={testId} className={`${classes} text-left hover:underline`}
      onClick={(e) => { e.stopPropagation(); open(fact.interviewId, fact.claimId); }}>
      {children}
    </button>
  );
}

export function InterviewRole({ role }) {
  if (!role) return null;
  return <ClaimText fact={role} title={roleTitle(role)} testId="member-interview-role" className="text-gray-700 dark:text-gray-300">{role.value}</ClaimText>;
}

export function InterviewLeftFlag({ left }) {
  if (!left) return null;
  return (
    <ClaimText fact={left} title={factTitle(left)} testId="member-left-flag"
      className="ml-2 rounded bg-amber-50 px-1.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
      {leftFlagText(left)}
    </ClaimText>
  );
}

export function InterviewRejoinedFlag({ rejoined }) {
  if (!rejoined) return null;
  return (
    <ClaimText fact={rejoined} title={rejoinedTitle(rejoined)} testId="member-rejoined-flag"
      className="ml-2 rounded bg-sky-50 px-1.5 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">
      {rejoinedText(rejoined)}
    </ClaimText>
  );
}
