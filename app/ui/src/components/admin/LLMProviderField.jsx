import { providerLabel } from './LLMSettingsSection.helpers';

// Provider picker — one grid cell in the LLM settings form.
export default function LLMProviderField({ provider, providers, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
      <select
        aria-label="LLM provider"
        value={provider}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200"
      >
        {providers.map(p => (
          <option key={p} value={p}>{providerLabel(p)}</option>
        ))}
      </select>
    </div>
  );
}
