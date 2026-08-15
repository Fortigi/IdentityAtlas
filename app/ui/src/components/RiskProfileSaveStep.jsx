// Step 3 of the Risk Profile wizard — name the profile and choose whether it
// becomes the active one, then persist it via POST /api/risk-profiles.
export default function RiskProfileSaveStep({
  profileName, setProfileName, makeActive, setMakeActive,
  savingProfile, handleSaveProfile, setStepIdx,
}) {
  return (
    <div className="space-y-4 max-w-md">
      <h3 className="text-base font-semibold dark:text-white">Save profile</h3>
      <div>
        <label className="block text-xs font-medium mb-1 dark:text-gray-300">Profile name *</label>
        <input value={profileName} onChange={e => setProfileName(e.target.value)} className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200" />
      </div>
      <label className="flex items-center gap-2 text-sm dark:text-gray-300">
        <input type="checkbox" checked={makeActive} onChange={e => setMakeActive(e.target.checked)} />
        Make this the active profile
      </label>
      <div className="flex justify-between pt-2">
        <button onClick={() => setStepIdx(1)} className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:text-gray-300 dark:hover:bg-gray-700">← Back</button>
        <button onClick={handleSaveProfile} disabled={!profileName || savingProfile} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600">
          {savingProfile ? 'Saving…' : 'Save profile →'}
        </button>
      </div>
    </div>
  );
}
