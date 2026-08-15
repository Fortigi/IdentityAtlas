// Azure-OpenAI-only fields (endpoint / deployment / API version). Rendered as a
// fragment of grid cells so it slots directly into the settings form grid.
const FIELD_CLASS =
  'w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';
const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

export default function LLMAzureFields({ endpoint, deployment, apiVersion, onField }) {
  return (
    <>
      <div className="sm:col-span-2">
        <label className={LABEL_CLASS}>Azure endpoint</label>
        <input
          type="text"
          value={endpoint}
          onChange={e => onField('endpoint', e.target.value)}
          placeholder="https://my-resource.openai.azure.com"
          className={FIELD_CLASS}
        />
      </div>
      <div>
        <label className={LABEL_CLASS}>Deployment</label>
        <input
          type="text"
          value={deployment}
          onChange={e => onField('deployment', e.target.value)}
          placeholder="gpt-4o-prod"
          className={FIELD_CLASS}
        />
      </div>
      <div>
        <label className={LABEL_CLASS}>API version</label>
        <input
          type="text"
          value={apiVersion}
          onChange={e => onField('apiVersion', e.target.value)}
          placeholder="2024-08-01-preview"
          className={FIELD_CLASS}
        />
      </div>
    </>
  );
}
