import { useState } from 'react';
import { useHasPermission } from '@ui/auth/usePermissions';
import MySurveys from './surveys/MySurveys';
import SurveyForm from './surveys/SurveyForm';
import SurveyTemplates from './surveys/SurveyTemplates';
import { useSurveyRoute } from './surveys/surveyRoute';

// The Surveys tab (docs/architecture/survey-templates.md).
//
//   For you     the surveys sent to the signed-in person; #surveys?request=<id>
//               opens one (an analyst opens any, to fill it in on someone's behalf)
//   Templates   the survey templates, for an analyst (data.write.contexts)
//
// Sending a survey starts on a unit's or application's page (Send survey).

const TABS = [
  { key: 'mine', label: 'For you' },
  { key: 'templates', label: 'Templates', analyst: true },
];

export default function SurveysPage() {
  const canWrite = useHasPermission('data.write.contexts');
  const [requestId, openRequest] = useSurveyRoute();
  const [tab, setTab] = useState('mine');
  const tabs = TABS.filter(t => !t.analyst || canWrite);

  if (requestId) {
    return (
      <div className="p-6">
        <button type="button" onClick={() => openRequest(null)} className="mb-3 text-sm text-blue-700 hover:underline dark:text-blue-300">← All surveys</button>
        <SurveyForm requestId={requestId} onDone={() => openRequest(null)} />
      </div>
    );
  }
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between border-b border-gray-200 dark:border-gray-700">
        <h1 className="pb-2 text-xl font-semibold text-gray-900 dark:text-white">Surveys</h1>
        <div role="tablist" aria-label="Surveys" className="flex gap-1">
          {tabs.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key
                ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                : 'border-transparent text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'templates' && canWrite ? <SurveyTemplates /> : <MySurveys onOpen={openRequest} />}
    </div>
  );
}
