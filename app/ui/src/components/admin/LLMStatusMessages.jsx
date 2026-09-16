import LLMTestResult from './LLMTestResult';

// The save/clear status line plus the connection-test result panel.
export default function LLMStatusMessages({ message, testResult }) {
  return (
    <>
      {message && (
        <div className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
          {message.text}
        </div>
      )}
      {testResult && <LLMTestResult result={testResult} />}
    </>
  );
}
