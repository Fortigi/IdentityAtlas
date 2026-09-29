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

/**
 * How long the records of the last answer stay available to refer back to.
 *
 * Longer than a clarification, because the two are waiting for different
 * things. A clarification is a question the bot has just asked and the caller
 * is mid-reply to; "what were we looking at" survives a coffee. Not unbounded,
 * though: past this an unrelated question would silently inherit a set from a
 * conversation the caller has forgotten having.
 */
const ANSWER_TTL_MS = 30 * 60 * 1000;

/** A per-conversation store that forgets: oldest out past MAX_ENTRIES, and stale on read. */
function conversationStore(ttlMs) {
  const entries = new Map();
  return {
    put(conversationId, value, now) {
      if (!conversationId) return;
      entries.delete(conversationId);
      entries.set(conversationId, { value, at: now });
      while (entries.size > MAX_ENTRIES) {
        // Map iterates in insertion order and every set() re-inserts, so the
        // first key is always the least recently written.
        entries.delete(entries.keys().next().value);
      }
    },
    get(conversationId, now, consume) {
      const entry = entries.get(conversationId);
      if (!entry) return null;
      if (consume) entries.delete(conversationId);
      return now - entry.at > ttlMs ? null : entry.value;
    },
    clear() { entries.clear(); },
  };
}

const pending = conversationStore(TTL_MS);
const lastAnswer = conversationStore(ANSWER_TTL_MS);

/** Remember what a conversation is waiting to hear back. */
export function setPending(conversationId, value, now = Date.now()) {
  pending.put(conversationId, value, now);
}

/**
 * What this conversation was waiting to hear, if anything, and forget it.
 *
 * Reading is consuming: a clarification can only be answered once, and leaving
 * it in place is how a later unrelated question gets silently attached to a
 * question from an hour ago.
 */
export function takePending(conversationId, now = Date.now()) {
  return pending.get(conversationId, now, true);
}

/** Remember what the last answer in this conversation was about. */
export function rememberAnswer(conversationId, carried, now = Date.now()) {
  lastAnswer.put(conversationId, carried, now);
}

/**
 * What the last answer in this conversation was about, WITHOUT forgetting it.
 *
 * Unlike a clarification this is not consumed, because a caller may narrow the
 * same set twice — "and which of those are in an access package?" then "and who
 * owns those?" — and a set that vanished after one use would break the second
 * question in a way nobody could see from the chat.
 */
export function recallAnswer(conversationId, now = Date.now()) {
  return lastAnswer.get(conversationId, now, false);
}

/** Test seam: drop everything. */
export function clearPending() {
  pending.clear();
  lastAnswer.clear();
}

export const __ttlMs = TTL_MS;
export const __answerTtlMs = ANSWER_TTL_MS;
