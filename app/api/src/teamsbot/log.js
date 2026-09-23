// Teams bot (POC) — the conversation log.
//
// This used to hold the store. It moved to nlreports/conversations.js when the
// Ask tab started writing to the same table (migration 071): a store two front
// ends share belongs with the pipeline they share, not inside one of them. The
// bot's own code and tests import from here unchanged.

export * from '../nlreports/conversations.js';
