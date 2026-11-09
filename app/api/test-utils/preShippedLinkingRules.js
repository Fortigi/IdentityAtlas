// Account-linking rules exactly as a tenant's saved config holds them after a
// Save on a build that predates the `loginNameForm` signal (#1466).
//
// Saving the Account Linking settings persists the *whole* rules JSON shown in
// the editor — moving the certainty slider is enough — so a tenant that saved
// once on that build stores that build's complete dictionary, `loginNameForm`
// absent. This is that stored row's `rules`, for the tests that pin what happens
// when a later build ships a signal the saved dictionary predates (#1469).
//
// Derived by omission from the shipped dictionary rather than written out as a
// literal snapshot: #1466 only *added* the `loginNameForm` entry and changed no
// other value, so the shipped dictionary minus that entry is precisely what the
// earlier build shipped, and the duplication gate rejects a second hand-copy of
// a list this long. If a future change ever edits the other shipped values, this
// has to become a frozen literal of the pre-#1466 build instead.

import { DEFAULT_RULES } from '../src/accountlinking/defaultRules.js';

/** A deep copy, so a test that edits these rules cannot reach the shipped ones. */
const clone = (value) => JSON.parse(JSON.stringify(value));

export const PRE_LOGIN_NAME_FORM_RULES = {
  ...clone(DEFAULT_RULES),
  signals: clone(DEFAULT_RULES.signals).filter((s) => s.name !== 'loginNameForm'),
};
