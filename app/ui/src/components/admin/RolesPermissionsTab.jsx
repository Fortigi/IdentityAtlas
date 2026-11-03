import RolesPermissionsSection from '@ui/components/RolesPermissionsSection';
import RelativePermissionsSection from './RelativePermissionsSection';

// Admin → Roles & Permissions: the role → permission table, then — as its own
// section below it — the relative permissions (access that comes from how a
// person relates to the data rather than from a role in that table).
export default function RolesPermissionsTab() {
  return (
    <>
      <RolesPermissionsSection />
      <RelativePermissionsSection />
    </>
  );
}
