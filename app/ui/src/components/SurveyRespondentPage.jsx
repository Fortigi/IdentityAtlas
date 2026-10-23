// A survey respondent's view of Identity Atlas.
//
// Somebody with no Identity Atlas role who was sent a survey — the person an
// owner named as responsible, say — signs in and lands here instead of the
// app (AppRoot routes them; the API lets them reach the survey routes and the
// shell only). They see their surveys and answer them; nothing else.
// docs/architecture/survey-templates.md.

import { useAuth } from '@ui/auth/AuthGate';
import { useTheme } from '@ui/hooks/useTheme';
import { ThemeContext } from '@ui/contexts/ThemeContext';
import ErrorBoundary from './ErrorBoundary';
import Brand from './app/Brand';
import MySurveys from './surveys/MySurveys';
import SurveyForm from './surveys/SurveyForm';
import { useSurveyRoute } from './surveys/surveyRoute';

export default function SurveyRespondentPage() {
  const { account, logout } = useAuth();
  const { isDark, mode } = useTheme();
  const [requestId, openRequest] = useSurveyRoute();
  const userName = account?.name || account?.username;

  return (
    <ThemeContext.Provider value={{ isDark, mode }}>
      <ErrorBoundary>
        <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-gray-900">
          <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <div className="px-6 py-3 flex items-center gap-4">
              <Brand isDark={isDark} />
              <div className="flex-1" />
              {userName && <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{userName}</span>}
              {logout && (
                <button type="button" onClick={logout}
                  className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                  Sign out
                </button>
              )}
            </div>
          </header>
          <main className="flex-1 min-w-0 overflow-y-auto p-6">
            {requestId
              ? (
                <>
                  <button type="button" onClick={() => openRequest(null)} className="mb-3 text-sm text-blue-700 hover:underline dark:text-blue-300">← Your surveys</button>
                  <SurveyForm requestId={requestId} onDone={() => openRequest(null)} />
                </>
              )
              : (
                <div className="mx-auto max-w-3xl space-y-3">
                  <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Your surveys</h1>
                  <MySurveys onOpen={openRequest} />
                </div>
              )}
          </main>
        </div>
      </ErrorBoundary>
    </ThemeContext.Provider>
  );
}
