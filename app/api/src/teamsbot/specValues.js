// Teams bot (POC) — sentinel substitution.
//
// This used to hold the walker. It moved to nlreports/sentinels.js when the
// substitution moved INSIDE interpret(), before validation, where a model that
// writes `@me` no longer pays a repair round for it. The bot's own code and
// tests import from here unchanged.

export * from '../nlreports/sentinels.js';
