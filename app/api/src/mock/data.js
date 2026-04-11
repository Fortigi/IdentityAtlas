// Mock data that mirrors the actual SQL view structures from FortigiGraph
// This allows development and testing without a live SQL connection

const departments = ['Finance', 'IT', 'HR', 'Sales', 'Marketing', 'Legal', 'Operations'];
const jobTitles = {
  Finance: ['Financial Analyst', 'Controller', 'CFO', 'Accountant', 'Finance Manager'],
  IT: ['Developer', 'Sysadmin', 'IT Manager', 'Security Engineer', 'Cloud Architect'],
  HR: ['HR Specialist', 'Recruiter', 'HR Manager', 'Compensation Analyst', 'HRBP'],
  Sales: ['Account Executive', 'Sales Manager', 'SDR', 'VP Sales', 'Sales Engineer'],
  Marketing: ['Content Writer', 'Marketing Manager', 'SEO Specialist', 'CMO', 'Designer'],
  Legal: ['Legal Counsel', 'Paralegal', 'Compliance Officer', 'Legal Manager', 'DPO'],
  Operations: ['Operations Manager', 'Logistics Lead', 'COO', 'Facilities Manager', 'Procurement']
};

// Generate consistent user IDs
function userId(n) {
  return `u-${String(n).padStart(4, '0')}`;
}

function groupId(n) {
  return `g-${String(n).padStart(4, '0')}`;
}

// Users: 80 users across departments
const users = [];
let userIndex = 1;
for (const dept of departments) {
  const count = dept === 'IT' ? 15 : dept === 'Finance' ? 12 : 10;
  for (let i = 0; i < count; i++) {
    const titles = jobTitles[dept];
    const firstName = `${dept.substring(0, 3)}User${i + 1}`;
    users.push({
      id: userId(userIndex),
      displayName: `${firstName} ${dept}`,
      userPrincipalName: `${firstName.toLowerCase()}@contoso.com`,
      department: dept,
      jobTitle: titles[i % titles.length],
      accountEnabled: true
    });
    userIndex++;
  }
}

// Groups: security groups that represent typical role-based access
const groups = [
  // Department base groups
  { id: groupId(1), displayName: 'SG-Finance-Base', description: 'Base access for Finance', category: 'Department' },
  { id: groupId(2), displayName: 'SG-IT-Base', description: 'Base access for IT', category: 'Department' },
  { id: groupId(3), displayName: 'SG-HR-Base', description: 'Base access for HR', category: 'Department' },
  { id: groupId(4), displayName: 'SG-Sales-Base', description: 'Base access for Sales', category: 'Department' },
  { id: groupId(5), displayName: 'SG-Marketing-Base', description: 'Base access for Marketing', category: 'Department' },
  { id: groupId(6), displayName: 'SG-Legal-Base', description: 'Base access for Legal', category: 'Department' },
  { id: groupId(7), displayName: 'SG-Operations-Base', description: 'Base access for Operations', category: 'Department' },

  // Application access groups
  { id: groupId(10), displayName: 'APP-SAP-Read', description: 'SAP read access', category: 'Application' },
  { id: groupId(11), displayName: 'APP-SAP-Write', description: 'SAP write access', category: 'Application' },
  { id: groupId(12), displayName: 'APP-SAP-Admin', description: 'SAP admin access', category: 'Application' },
  { id: groupId(13), displayName: 'APP-Salesforce-Read', description: 'Salesforce read access', category: 'Application' },
  { id: groupId(14), displayName: 'APP-Salesforce-Write', description: 'Salesforce write access', category: 'Application' },
  { id: groupId(15), displayName: 'APP-SharePoint-Finance', description: 'SharePoint Finance site', category: 'Application' },
  { id: groupId(16), displayName: 'APP-SharePoint-HR', description: 'SharePoint HR site', category: 'Application' },
  { id: groupId(17), displayName: 'APP-SharePoint-AllCompany', description: 'SharePoint company-wide', category: 'Application' },
  { id: groupId(18), displayName: 'APP-Jira-Users', description: 'Jira access', category: 'Application' },
  { id: groupId(19), displayName: 'APP-Jira-Admin', description: 'Jira admin', category: 'Application' },
  { id: groupId(20), displayName: 'APP-Azure-DevOps', description: 'Azure DevOps access', category: 'Application' },

  // Privileged access groups
  { id: groupId(30), displayName: 'PAG-GlobalAdmin', description: 'Global admin role', category: 'Privileged' },
  { id: groupId(31), displayName: 'PAG-UserAdmin', description: 'User admin role', category: 'Privileged' },
  { id: groupId(32), displayName: 'PAG-SecurityReader', description: 'Security reader role', category: 'Privileged' },
  { id: groupId(33), displayName: 'PAG-HelpdeskAdmin', description: 'Helpdesk admin role', category: 'Privileged' },

  // Resource groups
  { id: groupId(40), displayName: 'RES-VPN-Access', description: 'VPN access', category: 'Resource' },
  { id: groupId(41), displayName: 'RES-Printer-Floor2', description: 'Floor 2 printers', category: 'Resource' },
  { id: groupId(42), displayName: 'RES-ConfRoom-Booking', description: 'Conference room booking', category: 'Resource' },
  { id: groupId(43), displayName: 'RES-WiFi-Corporate', description: 'Corporate WiFi', category: 'Resource' },
];

// Build permission assignments that simulate realistic role mining patterns
// This is the core mock for vw_UserPermissionAssignments
const permissionAssignments = [];

function addAssignment(uId, gId, membershipType) {
  const user = users.find(u => u.id === uId);
  const group = groups.find(g => g.id === gId);
  if (!user || !group) return;
  permissionAssignments.push({
    groupId: gId,
    groupDisplayName: group.displayName,
    groupTypeCalculated: group.groupTypeCalculated || 'Security Group',
    memberId: uId,
    memberDisplayName: user.displayName,
    memberUPN: user.userPrincipalName,
    memberType: '#microsoft.graph.user',
    membershipType,
    department: user.department,
    jobTitle: user.jobTitle,
    managedByAccessPackage: membershipType === 'Eligible'
  });
}

// Pattern 1: Everyone gets base department group + company-wide SharePoint + WiFi (Direct)
for (const user of users) {
  const deptIndex = departments.indexOf(user.department);
  addAssignment(user.id, groupId(deptIndex + 1), 'Direct');
  addAssignment(user.id, groupId(17), 'Direct');  // SharePoint AllCompany
  addAssignment(user.id, groupId(43), 'Direct');  // WiFi
}

// Pattern 2: Finance gets SAP Read + SharePoint Finance (Direct - role mining candidate!)
for (const user of users.filter(u => u.department === 'Finance')) {
  addAssignment(user.id, groupId(10), 'Direct');  // SAP Read
  addAssignment(user.id, groupId(15), 'Direct');  // SharePoint Finance
}

// Pattern 3: Finance managers also get SAP Write (Direct)
for (const user of users.filter(u => u.department === 'Finance' && u.jobTitle.includes('Manager'))) {
  addAssignment(user.id, groupId(11), 'Direct');  // SAP Write
}

// Pattern 4: IT gets Jira + Azure DevOps + VPN (Direct)
for (const user of users.filter(u => u.department === 'IT')) {
  addAssignment(user.id, groupId(18), 'Direct');  // Jira Users
  addAssignment(user.id, groupId(20), 'Direct');  // Azure DevOps
  addAssignment(user.id, groupId(40), 'Direct');  // VPN
}

// Pattern 5: IT managers get Jira Admin (Direct)
for (const user of users.filter(u => u.department === 'IT' && u.jobTitle.includes('Manager'))) {
  addAssignment(user.id, groupId(19), 'Direct');  // Jira Admin
}

// Pattern 6: Sales gets Salesforce (Direct)
for (const user of users.filter(u => u.department === 'Sales')) {
  addAssignment(user.id, groupId(13), 'Direct');  // Salesforce Read
  addAssignment(user.id, groupId(14), 'Direct');  // Salesforce Write
}

// Pattern 7: HR gets SharePoint HR (Direct)
for (const user of users.filter(u => u.department === 'HR')) {
  addAssignment(user.id, groupId(16), 'Direct');  // SharePoint HR
}

// Pattern 8: Some privileged access via Eligible (PIM) - IT security folks
for (const user of users.filter(u => u.jobTitle === 'Security Engineer' || u.jobTitle === 'Cloud Architect')) {
  addAssignment(user.id, groupId(32), 'Eligible');  // Security Reader
}

// Pattern 9: IT Manager is eligible for Global Admin (PIM)
for (const user of users.filter(u => u.department === 'IT' && u.jobTitle === 'IT Manager')) {
  addAssignment(user.id, groupId(30), 'Eligible');  // Global Admin
  addAssignment(user.id, groupId(31), 'Direct');    // User Admin (permanent)
}

// Pattern 10: Helpdesk via Indirect membership (nested group)
for (const user of users.filter(u => u.jobTitle === 'Sysadmin')) {
  addAssignment(user.id, groupId(33), 'Indirect');  // Helpdesk Admin via IT-Base nesting
}

// Pattern 11: Some "anomalies" for role mining to discover
// A few Finance users who also have Jira (why?)
addAssignment(userId(2), groupId(18), 'Direct');   // Finance user with Jira
addAssignment(userId(5), groupId(18), 'Direct');   // Finance user with Jira

// A Sales person with SAP Admin (over-provisioned!)
addAssignment(userId(40), groupId(12), 'Direct');  // Sales person with SAP Admin

// An HR person who is Owner of a Finance group
addAssignment(userId(25), groupId(1), 'Owner');    // HR person owns Finance base group

// Marketing person with VPN (only IT should have this)
addAssignment(userId(55), groupId(40), 'Direct');  // Marketing with VPN

// Pattern 12: Group Owners
for (const user of users.filter(u => u.jobTitle.includes('Manager'))) {
  const deptIndex = departments.indexOf(user.department);
  addAssignment(user.id, groupId(deptIndex + 1), 'Owner');
}

// Build unmanaged permissions (mock vw_UnmanagedPermissions)
// These are direct assignments that aren't governed by access packages
const unmanagedPermissions = permissionAssignments
  .filter(pa => pa.membershipType === 'Direct')
  .map(pa => ({
    userId: pa.memberId,
    userPrincipalName: pa.memberUPN,
    userDisplayName: pa.memberDisplayName,
    groupId: pa.groupId,
    groupName: pa.groupDisplayName,
    groupMail: null,
    roleName: 'Member',
    sourceType: 'Direct',
    source: 'Direct Assignment',
    permissionType: 'Membership'
  }));

export { users, groups, permissionAssignments, unmanagedPermissions };
