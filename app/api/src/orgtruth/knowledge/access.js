// Organisation knowledge extraction — gates and source visibility.
//
// Reading needs data.read, writing (upload, extract, review) data.write.contexts —
// the Org Info permissions — plus BOTH flags: orgTruth and knowledgeExtraction.
// A transcript classified 'restricted' is visible only to whoever uploaded it and
// to administrators (and never to a read-only API token).
import { requirePermission } from '../../middleware/auth.js';
import { isAuthEnabled } from '../../config/authConfig.js';
import { requireFeature } from '../../featureFlags.js';
import { actorOf } from '../import/httpHelpers.js';

export const FEATURE = 'knowledgeExtraction';
export const KNOWLEDGE_READ = [requirePermission('data.read'), requireFeature('orgTruth'), requireFeature(FEATURE)];
export const KNOWLEDGE_WRITE = [requirePermission('data.write.contexts'), requireFeature('orgTruth'), requireFeature(FEATURE)];

export function canSee(req, source) {
  if (!source) return false;
  if (source.metadata?.classification !== 'restricted') return true;
  if (!isAuthEnabled()) return true;
  if (req.readToken) return false;
  if (req.user?.permissions?.has?.('*')) return true;
  return source.uploadedBy != null && source.uploadedBy === actorOf(req);
}
