// Teams bot (POC) — the one round of memory the bot is allowed.
//
// "Multi-turn memory beyond one clarification round" is explicitly out of scope,
// so this is not a conversation store: it holds exactly what the NEXT message in
// a conversation needs to finish the question before it, and forgets it either
// way. That is one pending clarification per conversation, and nothing else.
//
// In memory, on purpose. A restart loses pending clarifications, and the user's
// next message is then treated as a fresh question — which reads as the bot
// having lost the thread, not as an error. For a POC on a single container that
// is the right trade against adding a table, a migration and a sweep for state
// whose whole lifetime is one reply. If the bot ever runs on more than one
// instance this becomes wrong immediately (two replicas, two Maps, and the
// clarification lands on whichever one Teams happens to hit) — that is the
// moment to move it into `BotConversations` rather than the moment to add
// sticky sessions.

const TTL_MS = 10 * 60 * 1000;

// Bounded so a bot that is talked to a lot cannot grow this without limit; the
// oldest pending clarification is the one nobody came back to answer.
const MAX_ENTRIES = 500;

const pending = new Map();

/** Remember what a conversation is waiting to hear back. */
export function setPending(conversationId, value, now = Date.now()) {
  if (!conversationId) return;
  pending.delete(conversationId);
  pending.set(conversationId, { value, at: now });
  while (pending.size > MAX_ENTRIES) {
    // Map iterates in insertion order, and every set() re-inserts, so the first
    // key is always the least recently written.
    pending.delete(pending.keys().next().value);
  }
}

/**
 * What this conversation was waiting to hear, if anything, and forget it.
 *
 * Reading is consuming: a clarification can only be answered once, and leaving
 * it in place is how a later unrelated question gets silently attached to a
 * question from an hour ago.
 */
export function takePending(conversationId, now = Date.now()) {
  const entry = pending.get(conversationId);
  if (!entry) return null;
  pending.delete(conversationId);
  return now - entry.at > TTL_MS ? null : entry.value;
}

/** Test seam: drop everything. */
export function clearPending() {
  pending.clear();
}

export const __ttlMs = TTL_MS;
