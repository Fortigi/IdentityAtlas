// Identity Atlas Interviews — evidence behind a statement.
//
// The recording and the transcript stay on the device. What the server keeps for each
// piece of evidence is where it is (segment, milliseconds, character span) and a
// fingerprint of the words: the SHA-256 of the excerpt. A reviewer holding the device's
// transcript can prove the excerpt is the one the statement was built on; the server
// cannot read it back.
//
// Only an interview created with storagePolicy 'evidence-excerpt' also keeps the
// excerpt text itself, and then only after its hash has been checked.
//
// The fingerprint is defined as: lowercase hex SHA-256 over the UTF-8 bytes of the
// excerpt in Unicode NFC. The iOS client must compute it the same way
// (`SHA256.hash(data: Data(excerpt.precomposedStringWithCanonicalMapping.utf8))`);
// evidence.test.js pins a known value so both sides can test against one vector.

import { createHash } from 'node:crypto';

export function excerptHash(excerpt) {
  return createHash('sha256').update(String(excerpt).normalize('NFC'), 'utf8').digest('hex');
}

/**
 * What to store for one validated evidence item under an interview's storage policy.
 * @param {{ excerptHash: string, excerpt: string|null }} evidence
 * @param {'local-only'|'evidence-excerpt'} storagePolicy
 * @returns {{ error: string } | { excerptText: string|null }}
 */
export function excerptToStore(evidence, storagePolicy) {
  if (evidence.excerpt === null) return { excerptText: null };
  // A local-only interview keeps no words on the server. Refused rather than dropped:
  // a client that sends them anyway has a privacy bug, and a silent drop would hide it.
  if (storagePolicy !== 'evidence-excerpt') {
    return { error: 'This interview is local-only: send the excerptHash, not the excerpt text' };
  }
  if (excerptHash(evidence.excerpt) !== evidence.excerptHash) {
    return { error: 'excerptHash does not match the excerpt' };
  }
  return { excerptText: evidence.excerpt };
}
