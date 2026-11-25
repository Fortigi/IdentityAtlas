// Accountable or Responsible, as a small badge beside what someone answers for —
// a context in the owner's list, a business role under its portfolio.

const ROLE_BADGE = {
  Accountable: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700',
  Responsible: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',
};

export default function RoleBadge({ role }) {
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[role] || ROLE_BADGE.Responsible}`}>
      {role}
    </span>
  );
}
