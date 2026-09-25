import { useState } from 'react';
import WizardShell from '@ui/components/WizardShell';
import Select from '@ui/components/inputs/Select';
import { canSubmitCredentials, buildCredentialFields } from '@ui/utils/crawlerCredentials';
import CredentialFields from '@ui/components/crawler/CredentialFields';
import useCredentialFields from '@ui/components/crawler/useCredentialFields';
import useCrawlerSave from '@ui/components/crawler/useCrawlerSave';
import { CrawlerField, OptionList, ScheduleList, WizardNav } from '@ui/components/crawler/wizardFields';
import QuerySlotEditor from './QuerySlotEditor.jsx';
import { PRESETS } from './sqlPresets.js';
import {
  appendPresetSlots, buildSqlConfigPayload, canSubmitQueries, isValidPort,
  newQuerySlot, seedWizardState, validateQueries,
} from './wizardLogic.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CRAWLER_TYPE = 'sql';

// SQL authentication is a login + password — exactly the pair the shared
// BasicAuth credential set collects and vaults. There is no authMethod field in
// this crawler's config; the constant only selects the fields.
const AUTH_METHOD = 'BasicAuth';

const CONNECTION_OPTIONS = [
  { key: 'encrypt',                label: 'Encrypt connection',       description: 'TLS between the worker and SQL Server (recommended)' },
  { key: 'trustServerCertificate', label: 'Trust server certificate', description: 'accept a certificate that is not signed by a trusted CA (self-signed on-premises servers)' },
];

const ADVANCED_FIELDS = [
  { key: 'connectTimeoutSeconds', label: 'Connect timeout (seconds)', hint: 'How long to wait for the connection to open (default 30)' },
  { key: 'commandTimeoutSeconds', label: 'Command timeout (seconds)', hint: 'Per network read, so a streaming query is not cut off as a whole; 0 = no limit (default 600)' },
  { key: 'batchSize',             label: 'Batch size',                hint: 'Records per ingest call; rows stream and are flushed every batch (default 5000)' },
  { key: 'pageSize',              label: 'Page size',                 hint: 'Bound to @PageSize for a query that pages with @Offset / @PageSize (default 10000)' },
];

const SMALL_SELECT_CLS = 'text-sm border border-gray-300 rounded px-2 py-1 bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const SMALL_BTN_CLS = 'px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function SqlConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  // Non-secret fields seed from the stored config on edit (seedWizardState);
  // the password starts blank — blank = keep the vaulted value.
  const seed = seedWizardState(initialConfig);
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(seed.displayName);
  const [server, setServer]           = useState(seed.server);
  const [port, setPort]               = useState(seed.port);
  const [database, setDatabase]       = useState(seed.database);
  const [systemName, setSystemName]   = useState(seed.systemName);
  const [connection, setConnection]   = useState(seed.connection);
  const [advanced, setAdvanced]       = useState(seed.advanced);
  const setAdvancedField = (key, value) => setAdvanced(prev => ({ ...prev, [key]: value }));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { creds, setCred } = useCredentialFields(initialConfig);

  const [queries, setQueries] = useState(seed.queries);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const addQuery    = () => setQueries(prev => [...prev, newQuerySlot()]);
  const removeQuery = i => setQueries(prev => prev.filter((_, idx) => idx !== i));
  const updateQuery = (i, field, value) => setQueries(prev => prev.map((q, idx) => (idx === i ? { ...q, [field]: value } : q)));
  const loadPreset  = () => setQueries(prev => appendPresetSlots(prev, presetId));
  const preset = PRESETS.find(p => p.id === presetId);

  const [schedules, setSchedules] = useState(seed.schedules);
  const { save, saving, error } = useCrawlerSave({
    authFetch, crawlerType: CRAWLER_TYPE, configId: initialConfig?.id, onComplete,
  });

  const canStep1 = !!(displayName.trim() && server.trim() && database.trim() && isValidPort(port));
  const canStep2 = canSubmitCredentials(AUTH_METHOD, creds, isEdit);
  const queryErrors = validateQueries(queries);
  const canStep3 = canSubmitQueries(queries);

  const handleSave = async () => {
    const configPayload = buildSqlConfigPayload({
      server, port, database, ...connection, ...advanced, systemName, queries, schedules,
    });
    Object.assign(configPayload, buildCredentialFields(AUTH_METHOD, creds));
    await save(displayName, configPayload);
  };

  const steps = [
    { n: 1, label: 'Connection' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Queries' },
    { n: 4, label: 'Schedule' },
  ];

  return (
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} SQL Database Crawler`}
      onCancel={onCancel}
      steps={steps}
      currentStep={step}
      onStepClick={setStep}
      allowAllSteps={isEdit}
      error={error}
    >

      {/* Step 1 — Connection */}
      {step === 1 && (
        <div className="space-y-4">
          <CrawlerField label="Crawler Name" value={displayName} onChange={setDisplayName} placeholder="SQL Database" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <CrawlerField
                label="Server" mono value={server} onChange={setServer} placeholder="sql01.corp.local"
                hint={<>Host name or address; a named instance is written <code>host\instance</code></>}
              />
            </div>
            <CrawlerField
              label="Port" optional mono value={port} onChange={setPort} placeholder="1433"
              hint={isValidPort(port) ? 'Blank = default (1433) or a named instance' : 'Enter a port between 1 and 65535'}
            />
          </div>
          <CrawlerField label="Database" mono value={database} onChange={setDatabase} placeholder="identityiq" />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Connection security</label>
            <OptionList
              options={CONNECTION_OPTIONS} type="checkbox" name="connectionOptions" selected={connection}
              onSelect={(key, checked) => setConnection(prev => ({ ...prev, [key]: checked }))}
            />
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <button type="button" onClick={() => setShowAdvanced(a => !a)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
              {showAdvanced ? '▲ Hide' : '▶ Advanced (timeouts, batching, system name)'}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {ADVANCED_FIELDS.map(f => (
                    <CrawlerField key={f.key} label={f.label} type="number" value={advanced[f.key]} onChange={v => setAdvancedField(f.key, v)} hint={f.hint} />
                  ))}
                </div>
                <CrawlerField
                  label="System name" optional value={systemName} onChange={setSystemName} placeholder="IdentityIQ"
                  hint="How this source is labelled in Identity Atlas. Leave blank to use the crawler name above."
                />
              </div>
            )}
          </div>
          <WizardNav onNext={() => setStep(2)} nextDisabled={!canStep1} />
        </div>
      )}

      {/* Step 2 — Credentials */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            SQL Server authentication (login + password). The login needs SELECT on the tables the queries read.
            {isEdit && <span className="ml-2 text-xs">(leave the password blank to keep the stored value)</span>}
          </p>
          <CredentialFields
            authMethod={AUTH_METHOD} values={creds} onChange={setCred} isEdit={isEdit}
            placeholders={{ username: 'ia_reader' }}
          />
          <WizardNav onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!canStep2} />
        </div>
      )}

      {/* Step 3 — Queries */}
      {step === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            One SELECT statement per object type. Column names are matched case-insensitively with underscores ignored;
            every other column is kept in <code>extendedAttributes</code>. Reference <code>@Offset</code> and <code>@PageSize</code> to
            have the crawler page through a statement.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={addQuery} className={SMALL_BTN_CLS}>+ Add query</button>
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">Load example:</span>
            <Select value={presetId} onChange={e => setPresetId(e.target.value)} className={SMALL_SELECT_CLS} wrapperClassName="w-56">
              {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <button type="button" onClick={loadPreset} className={SMALL_BTN_CLS}>
              {queries.length ? 'Append example queries' : 'Load example queries'}
            </button>
          </div>
          {preset && <p className="text-xs text-gray-500 dark:text-gray-400">{preset.description}. The SQL is a starting point — adjust it to your schema.</p>}

          {queries.length === 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-400">
              No queries yet. Add a query or load an example set.
            </div>
          )}
          {queries.map((q, i) => (
            <QuerySlotEditor key={i} slot={q} index={i} onUpdate={updateQuery} onRemove={removeQuery} />
          ))}

          {queries.length > 0 && queryErrors.length > 0 && (
            <ul className="text-xs text-amber-600 dark:text-amber-400 list-disc pl-4 space-y-0.5">
              {queryErrors.slice(0, 5).map(e => <li key={e}>{e}</li>)}
            </ul>
          )}

          <WizardNav onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={!canStep3} />
        </div>
      )}

      {/* Step 4 — Schedule & save */}
      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Schedule automatic syncs. A full sync also removes rows the queries no longer return; a delta sync only adds and updates.
          </p>
          <ScheduleList schedules={schedules} onChange={setSchedules} />
          <WizardNav
            onBack={() => setStep(3)} onNext={handleSave} nextDisabled={saving}
            nextLabel={saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Crawler'}
            nextCls="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
          />
        </div>
      )}
    </WizardShell>
  );
}
