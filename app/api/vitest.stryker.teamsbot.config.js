import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the Teams bot mutation run (stryker.teamsbot.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it resolves a path that does not exist there, fails the dry run, and
// aborts the whole run before a single mutant is evaluated.
//
// Listed instead of excluded: an excluded test that happened to be some mutant's only killer
// would surface as a false survivor, which is worse than measuring less. Every test here is a
// real killer for the mutated files. routes/teamsBot.test.js is included even though the route
// itself is not mutated — it is the only test that exercises the bot-answer handler, which is
// what gives log.js's findAnswerForCaller its caller-scoping mutants a killer at the HTTP
// boundary as well as at the query one.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/routes/teamsBot.test.js',
      'src/teamsbot/auth.test.js',
      'src/teamsbot/caller.test.js',
      'src/teamsbot/callerSpec.test.js',
      'src/teamsbot/card.test.js',
      'src/teamsbot/log.test.js',
      'src/teamsbot/service.test.js',
      'src/teamsbot/signInDialog.test.js',
      'src/teamsbot/state.test.js',
      'src/teamsbot/text.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
