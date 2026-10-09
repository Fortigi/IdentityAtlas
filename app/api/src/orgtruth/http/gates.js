// The two gates every org-truth route uses. Per route, never on the mount
// (a mount-level gate on '/api' would apply to every router mounted later).
//
// MVP decision: no permission of its own yet. Reading the organisation truth
// needs `data.read`; writing it (uploading, importing, accepting links) reuses
// `data.write.contexts` ("Build contexts"), because the import ends in
// generated contexts and that is the permission a role miner already has.
// A dedicated `data.write.org` comes with the permission manifest + docs
// changes when this leaves the MVP stage.
import { requirePermission } from '../../middleware/auth.js';
import { requireFeature } from '../../featureFlags.js';

export const FEATURE = 'orgTruth';
export const READ_GATE = [requirePermission('data.read'), requireFeature(FEATURE)];
export const WRITE_GATE = [requirePermission('data.write.contexts'), requireFeature(FEATURE)];
