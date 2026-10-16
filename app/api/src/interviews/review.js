// Identity Atlas Interviews — the review gate.
//
// A proposal is about ONE version of a statement. An analyst's review names the version
// they read (`targetVersion`), so a decision can never land on words they did not see:
//
//   • targetVersion must be the proposal's version                       → else 409
//   • approving needs that version to still be the latest of its lineage → else 409
//     (the claim was revised after the proposal; propose the new version)
//   • approve and reject are final for a proposal; defer is not           → else 409
//
// Approval records a decision. It does not promote anything into the canonical model —
// that step does not exist in this slice, and the API says so (`promoted: false`).

export const FINAL_ACTIONS = Object.freeze(['approve', 'reject']);

/**
 * @param {{ proposalVersion: number, latestVersion: number, currentAction: string|null }} state
 * @param {{ action: string, targetVersion: number }} review
 * @returns {string|null} why the review is refused (HTTP 409), or null
 */
export function checkReview(state, review) {
  if (FINAL_ACTIONS.includes(state.currentAction)) {
    return `This proposal was already ${state.currentAction === 'approve' ? 'approved' : 'rejected'}; make a new proposal to revisit it`;
  }
  if (review.targetVersion !== state.proposalVersion) {
    return `This proposal is about version ${state.proposalVersion} of the statement, not version ${review.targetVersion}`;
  }
  if (review.action === 'approve' && state.latestVersion !== state.proposalVersion) {
    return `The statement was revised to version ${state.latestVersion} after this proposal was made; propose that version instead`;
  }
  return null;
}

/** The review state a proposal is in, from its latest decision. */
export function reviewState(latestAction) {
  if (latestAction === 'approve') return 'approved';
  if (latestAction === 'reject') return 'rejected';
  if (latestAction === 'defer') return 'deferred';
  return 'proposed';
}
