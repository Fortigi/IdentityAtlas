// Names and values for the scale test fixture. Neutral, invented vocabulary —
// nothing here is taken from any real organisation's data.
//
// Every name is a PURE function of (index, key): the emitters stream rows in index
// order and can re-derive any earlier row's name without having kept it, which is
// how a near-collision refers back to the name it collides with.

import { fmix32 } from './random.mjs';

const FIRST = ('Aaron Abby Adam Adrian Aisha Alan Alex Alice Amara Amir Ana Andre Anika Anna Arjun Astrid Ben Bianca Boris Bram Carla Carlos Chen Chloe Chris Clara Daan Dana Daniel Daria David Dev Diego Dina Elena Eli Emma Eric Esra Eva Fatima Felix Finn Fleur Frank Gabriel Grace Hana Hannah Hugo Ian Ines Ingrid Isaac Ivan Jada Jan Jasper Jens Joanna Jonas Jorge Julia Kai Karin Kenji Kim Lara Lars Laura Leo Lina Lisa Luca Lucas Maja Marco Maria Mark Marta Max Maya Mehmet Mila Milan Mira Nadia Nina Noah Nora Olaf Olga Omar Oscar Paula Pedro Petra Priya Quinn Rafael Rana Ravi Rosa Ruben Ruth Sam Sara Sofia Stefan Sven Tariq Tess Thomas Tim Tomas Uma Vera Victor Wei Willem Yara Yusuf Zara Zoe').split(' ');
const LAST = ('Adams Ahmed Alvarez Andersen Baker Bakker Becker Bos Brandt Brown Castro Chen Claes Cohen Costa Dekker Dias Dijkstra Edwards Evans Fischer Flores Garcia Gomez Graham Gupta Hansen Hartmann Hoekstra Huang Jansen Jensen Johnson Kaya Keller Khan Kim Klein Koch Kowalski Kumar Larsen Lee Lopez Maas Martin Meijer Meyer Molina Moreau Mulder Murphy Nagy Nguyen Nielsen Novak Okafor Olsen Ortiz Park Patel Perez Peters Petrov Popescu Ramos Reyes Richter Rossi Ruiz Sanchez Santos Schmidt Schulz Silva Singh Smit Smith Stewart Suzuki Tanaka Taylor Torres Vargas Visser Vos Wagner Walker Wang Weber Wong Wu Yilmaz Young Zhang Zimmermann').split(' ');
const DEPARTMENTS = ['Finance', 'Human Resources', 'Operations', 'Sales', 'Marketing', 'Legal', 'Procurement', 'Logistics', 'Customer Service', 'Research', 'Engineering', 'Facilities', 'Treasury', 'Audit', 'Risk', 'Security', 'IT Infrastructure', 'Application Development', 'Data Office', 'Communications'];
const TITLES = ['Analyst', 'Senior Analyst', 'Specialist', 'Advisor', 'Coordinator', 'Officer', 'Team Lead', 'Manager', 'Senior Manager', 'Director', 'Engineer', 'Architect', 'Consultant', 'Administrator', 'Controller', 'Assistant', 'Clerk', 'Operator', 'Planner', 'Developer'];
const EMPLOYEE_TYPES = ['Employee', 'Employee', 'Employee', 'Employee', 'Contractor', 'Contractor', 'Service', 'Temporary'];
const AREAS = ['AP', 'AR', 'GL', 'HR', 'PAY', 'INV', 'PO', 'SO', 'CRM', 'DMS', 'WMS', 'MES', 'BI', 'ITSM', 'IAM', 'TRS', 'LAB', 'QA', 'FAC', 'LEG'];
const ACTIONS = ['READ', 'DISPLAY', 'CREATE', 'CHANGE', 'APPROVE', 'RELEASE', 'POST', 'DELETE', 'ADMIN', 'AUDIT', 'EXPORT', 'MAINTAIN'];
const OUS = ['Groups', 'Security Groups', 'Application Groups', 'Distribution', 'Resources', 'Roles'];
const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Global'];
const PRODUCT_WORDS = ['Ledger', 'Payroll', 'Portal', 'Warehouse', 'Planner', 'Vault', 'Tracker', 'Studio', 'Gateway', 'Registry', 'Console', 'Archive', 'Scheduler', 'Hub', 'Desk', 'Insight', 'Connect', 'Workbench', 'Catalog', 'Monitor'];
const CONNECTOR_KINDS = [
  { type: 'LDAP', label: 'Directory', directory: true },
  { type: 'ERP', label: 'ERP' },
  { type: 'Database', label: 'Database' },
  { type: 'SaaS', label: 'Cloud App' },
  { type: 'Mainframe', label: 'Mainframe' },
  { type: 'ITSM', label: 'Service Desk' },
  { type: 'FileShare', label: 'File Services' },
];

const pick = (arr, h) => arr[h % arr.length];

export function userName(index, key) {
  const h = fmix32((index ^ key) >>> 0);
  const first = pick(FIRST, h);
  const last = pick(LAST, h >>> 8);
  const initial = String.fromCharCode(65 + ((h >>> 20) % 26));
  return { first, last, display: `${first} ${initial}. ${last}` };
}

export function userAttributes(index, key) {
  const h = fmix32((index ^ key ^ 0x5bd1e995) >>> 0);
  return {
    department: pick(DEPARTMENTS, h),
    jobTitle: pick(TITLES, h >>> 7),
    employeeType: pick(EMPLOYEE_TYPES, h >>> 14),
  };
}

// Connector catalog. Index 0 (the largest by connectorSkew) is always a directory,
// so the bulk of the entitlements carry distinguished names; the others follow
// `directoryShare`.
export function connectorCatalog(count, directoryShare, rng) {
  const kinds = CONNECTOR_KINDS.filter(k => !k.directory);
  const out = [];
  for (let i = 0; i < count; i++) {
    const directory = i === 0 || rng.next() < directoryShare;
    const kind = directory ? CONNECTOR_KINDS[0] : rng.pick(kinds);
    const n = String(i + 1).padStart(2, '0');
    out.push({
      index: i,
      name: `${kind.label} ${rng.pick(PRODUCT_WORDS)} ${n}`,
      type: kind.type,
      directory,
      code: `${kind.type.slice(0, 3).toUpperCase()}${n}`,
    });
  }
  return out;
}

export function applicationName(index, key) {
  const h = fmix32((index ^ key) >>> 0);
  return `${pick(PRODUCT_WORDS, h)} ${pick(DEPARTMENTS, h >>> 6)} ${String(index + 1).padStart(4, '0')}`;
}

// The raw entitlement value. Directory connectors emit an LDAP distinguished name
// — several commas per value, which is the whole reason the fixture defaults to
// tab-separated output.
export function entitlementValue(index, key, connector) {
  const h = fmix32((index ^ key) >>> 0);
  const area = pick(AREAS, h);
  const action = pick(ACTIONS, h >>> 5);
  // The whole hash, so every value is unique (h is a bijection of the index) and
  // the only duplicates in the file are the deliberate near-collisions.
  const serial = h.toString(36).toUpperCase();
  if (connector.directory) {
    return `CN=GRP-${area}-${action}-${serial},OU=${pick(OUS, h >>> 9)},OU=${pick(REGIONS, h >>> 17)},DC=corp,DC=example,DC=com`;
  }
  return `${connector.code}_${area}_${action}_${serial}`;
}

// Description text — always carries commas, whatever the connector.
export function entitlementDescription(index, key) {
  const h = fmix32((index ^ key ^ 0x27d4eb2f) >>> 0);
  return `Grants ${pick(ACTIONS, h).toLowerCase()} access to ${pick(AREAS, h >>> 5)} data, ${pick(REGIONS, h >>> 10)} region, ${pick(DEPARTMENTS, h >>> 15)}`;
}

// Near-collision of `name`: the same text differing only by case or trailing
// whitespace. `variant` selects which.
export function nearCollision(name, variant) {
  switch (variant % 3) {
    case 0: return name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase();
    case 1: return name.toLowerCase() === name ? name.toUpperCase() : name.toLowerCase();
    default: return `${name} `;
  }
}

// Does row `index` collide with an earlier one, and if so which? Pure, so a
// streaming emitter can decide without remembering earlier rows. Returns the
// earlier index, or -1.
export function collisionSource(index, key, share) {
  if (index === 0 || share <= 0) return -1;
  const h = fmix32((index ^ key ^ 0x9e3779b9) >>> 0);
  if (h / 4294967296 >= share) return -1;
  return fmix32(h) % index;
}
