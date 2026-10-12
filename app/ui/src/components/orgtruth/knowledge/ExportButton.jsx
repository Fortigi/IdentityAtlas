// Download the transcript's full JSON package (GET /knowledge/sources/:id/export).
// The server names the file through Content-Disposition.
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { API } from '@ui/components/orgtruth/wizard/wizardApi';
import { SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { KNOWLEDGE } from './knowledgeFormat';
import { downloadFile } from './knowledgeDownload';

export default function ExportButton({ source }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();

  async function exportJson() {
    try {
      await downloadFile(authFetch, `${API}${KNOWLEDGE}/sources/${encodeURIComponent(source.id)}/export`, `knowledge-${source.id}.json`);
    } catch (err) {
      dialog.alert(`The export failed: ${err.message}`);
    }
  }

  return <button type="button" className={SMALL_BUTTON} onClick={exportJson}>Export JSON</button>;
}
