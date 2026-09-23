// Teams bot (POC) — who is asking.
//
// This used to hold caller resolution. It moved to nlreports/caller.js when the
// Ask tab needed the same thing: a caller is a property of the pipeline both
// front ends share, not of one of them. The bot's own code and tests import
// from here unchanged.

export * from '../nlreports/caller.js';
