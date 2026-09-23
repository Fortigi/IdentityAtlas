// Teams bot (POC) — follow-up questions.
//
// This used to hold the follow-up logic. It moved to nlreports/followUp.js when
// the Ask tab needed the same thing: "these groups" is a property of the
// pipeline both front ends share. The bot's own code imports from here unchanged.

export * from '../nlreports/followUp.js';
