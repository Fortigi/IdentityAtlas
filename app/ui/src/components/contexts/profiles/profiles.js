// Detail profiles per template: which facts a context's page shows first, and
// in which words. Organisational units and logical applications get one; a
// Tag, a Segment or a context without a template keeps the generic detail
// page (profileFor returns null).
//
//   title            heading of the facts card
//   noun             what the page calls the context ("this unit")
//   accountableLabel what the Accountable role is called here (an
//                    application's Accountable is its Owner)
//   membersLabel     the label of the member-count fact when it does not name
//                    the kind of member
//   membersWithKind  label the member fact with the kind of member
//                    ("Accounts") — a unit can hold any kind; an
//                    application's members are always resources
//   showSubUnits     show the number of sub-units
//   variantsLabel    heading of the same unit held as other kinds of member;
//                    the section is shown only when there are such variants

export const PROFILES = {
  OrganizationalUnit: {
    title: 'About this unit',
    noun: 'this unit',
    accountableLabel: 'Accountable',
    membersLabel: 'Members',
    membersWithKind: true,
    showSubUnits: true,
    variantsLabel: 'This unit as',
  },
  LogicalApplication: {
    title: 'About this application',
    noun: 'this application',
    accountableLabel: 'Owner',
    membersLabel: 'Resources',
    membersWithKind: false,
    showSubUnits: false,
    variantsLabel: 'This application as',
  },
};

export function profileFor(contextCategory) {
  return PROFILES[contextCategory] || null;
}
