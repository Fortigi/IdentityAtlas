// Organisation → Sources (workstream T6).
//
// Lists every uploaded source (GET /api/org-truth/sources): name, kind, observed
// date, uploader, size, and the runs it fed (GET /api/org-truth/runs). A row
// offers Download (the original bytes) and, for a list, "Import again" which
// opens the wizard in repeat mode with the profile of its last run.
//
// Props: { onOpenDetail, refreshKey }
import NotBuiltYet from './NotBuiltYet';

export default function SourcesTab() {
  return <NotBuiltYet what="Sources" workstream="T6" />;
}
