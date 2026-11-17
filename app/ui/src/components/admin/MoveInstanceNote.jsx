import { docsUrl } from '@ui/utils/docsUrl';
import { BackupIcon } from './adminIcons';

// Points at the backup/restore guide for moving Identity Atlas to a new
// instance. A database backup carries everything people made here (tags,
// contexts, overrides, reviews, settings), which a per-table export never did.
export const MOVE_INSTANCE_DOCS_PATH = '/admin/backup-restore-upgrade/#move-identity-atlas-to-a-new-instance';

export default function MoveInstanceNote({ version }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-4">
      <span className="text-gray-500 dark:text-gray-400 mt-0.5"><BackupIcon /></span>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        To move to a new instance, back up and restore the database. A backup carries all data, including
        everything people made here.{' '}
        <a
          href={docsUrl(version, MOVE_INSTANCE_DOCS_PATH)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-blue-700 dark:text-blue-300 hover:underline"
        >
          Read the backup and restore guide →
        </a>
      </p>
    </div>
  );
}
