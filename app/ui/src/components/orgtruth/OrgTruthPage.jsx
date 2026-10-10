// Organisation — the page behind the "Organisation" nav tab (feature `orgTruth`).
//
// Four sub-tabs, each its own file so the workstreams can build them in parallel:
//   Sources   what was uploaded, when it was observed, what each run did     (SourcesTab, T6)
//   Model     the meta-graph: entity types, predicates, links to system types (ModelTab, T6)
//   Entities  the entities themselves, searchable, with a detail fan-out      (EntitiesTab, T6)
//   Review    proposed links and claims waiting for an analyst                (ReviewTab, T6)
// plus the import wizard (ImportWizard, T5), opened from the Sources tab's
// "Import additional information" button (new import) or from a source's "Import
// again" (repeat mode, `profileId` of its last run). Every panel gets onImport /
// onImportAgain; a finished import bumps refreshKey, which remounts the panel so
// it fetches again.
//
// This file is composition only: tab state, the header, and which panel shows.
import { useState } from 'react';
import TabBar from '@ui/components/TabBar';
import SourcesTab from './SourcesTab';
import ModelTab from './ModelTab';
import EntitiesTab from './EntitiesTab';
import ReviewTab from './ReviewTab';
import ImportWizard from './wizard/ImportWizard';
import { ORG_TABS } from './orgTabs';

const PANELS = { sources: SourcesTab, model: ModelTab, entities: EntitiesTab, review: ReviewTab };

export default function OrgTruthPage({ onOpenDetail }) {
  const [tab, setTab] = useState('sources');
  // null = closed; { profileId? } = open (a profileId opens it in repeat mode).
  const [wizard, setWizard] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const Panel = PANELS[tab] ?? SourcesTab;

  const openWizard = () => setWizard({});
  const onImportAgain = (profileId) => setWizard({ profileId });
  const closeWizard = (imported) => {
    setWizard(null);
    if (imported) setRefreshKey(k => k + 1);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Organisation</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          What the organisation says about itself — projects, assets, teams, data domains and their owners —
          next to what the systems say. Uploaded as lists, kept as they were given, linked to accounts, groups and contexts.
        </p>
      </div>

      {wizard && <ImportWizard onClose={closeWizard} profileId={wizard.profileId} />}

      <TabBar tabs={ORG_TABS} active={tab} onChange={setTab} />
      <Panel
        key={`${tab}-${refreshKey}`}
        onOpenDetail={onOpenDetail}
        refreshKey={refreshKey}
        onImport={openWizard}
        onImportAgain={onImportAgain}
      />
    </div>
  );
}
