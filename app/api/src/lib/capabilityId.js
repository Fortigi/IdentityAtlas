// Deterministic capability-resource id (SHA256-UUID).
//
// A "capability-resource" represents "<capability> @ <target node>" — an Azure role at a
// scope, an app role on an application, a permission level on a folder, and so on. Its id
// must be IDENTICAL whether the row is written by a crawler (PowerShell) or synthesized on
// the fly by the effective-access engine (this module). If the two diverged, an inherited
// (synthesized) row and a directly-declared (stored) row for the same (capability, node)
// would carry different ids and fail to collapse into a single matrix row.
//
// Algorithm (docs/architecture/effective-access-engine.md §11):
//   input = UTF-8 bytes of `${targetNodeId}|${capabilityId}`
//   hash  = SHA256(input)                       // 32 bytes
//   id    = lowercase hex of hash[0..15], formatted xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//
// No RFC-4122 version/variant bits are set: this is an opaque deterministic primary key,
// not a "real" UUIDv5. The PowerShell counterpart is tools/crawlers/shared/Get-CapabilityId.ps1;
// both runtimes are pinned to the same golden vectors so they cannot drift apart.

import { createHash } from 'node:crypto';

// Reserved field separator. Changing this is a one-way door — it would invalidate every
// stored capability-resource id and require re-crawling all sources. See spec §11.
const SEPARATOR = '|';

/**
 * Compute the deterministic id of a capability-resource ("<capability> @ <target node>").
 *
 * @param {string} targetNodeId the node the capability applies to (must not contain '|')
 * @param {string} capabilityId the capability — role / permission level / right (must not contain '|')
 * @returns {string} a UUID-formatted, deterministic, opaque identifier
 * @throws {TypeError} if either argument is not a string
 * @throws {Error} if either argument contains the reserved separator
 */
export function capabilityResourceId(targetNodeId, capabilityId) {
  if (typeof targetNodeId !== 'string' || typeof capabilityId !== 'string') {
    throw new TypeError('capabilityResourceId: targetNodeId and capabilityId must both be strings');
  }
  if (targetNodeId.includes(SEPARATOR) || capabilityId.includes(SEPARATOR)) {
    throw new Error(
      `capabilityResourceId: '${SEPARATOR}' is reserved as the field separator and must not ` +
        'appear in targetNodeId or capabilityId',
    );
  }

  const hex = createHash('sha256')
    .update(`${targetNodeId}${SEPARATOR}${capabilityId}`, 'utf8')
    .digest('hex')
    .slice(0, 32); // first 16 bytes

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export { SEPARATOR as CAPABILITY_ID_SEPARATOR };
