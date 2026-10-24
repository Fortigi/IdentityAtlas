import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the survey-templates mutation run
// (stryker.surveys.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include is the survey helpers tests and the
// mount tests that drive the form, the pages and the context cards.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/surveys/surveyText.test.js',
      'src/components/surveys/surveyRoute.test.js',
      'src/components/surveys/SurveyForm.mount.test.jsx',
      'src/components/surveys/AnswerInput.mount.test.jsx',
      'src/components/surveys/surveyPages.mount.test.jsx',
      'src/components/contexts/surveys/roster.helpers.test.js',
      'src/components/contexts/surveys/send.helpers.test.js',
      'src/components/contexts/surveys/surveyCards.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
