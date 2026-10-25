// Survey templates — the four that ship with Identity Atlas. Seeded once by key
// (seed.js); after that they are the analyst's to change like any other. Neutral
// names only: a customer's own wording goes into that customer's environment.

const OWNER_QUESTIONS = (what, wat) => [
  {
    id: 'isOwner',
    text: { en: `Are you the owner of this ${what}, {context}?`, nl: `Bent u de eigenaar van ${wat} {context}?` },
    help: { en: 'The owner is the one person who answers for it.', nl: 'De eigenaar is de ene persoon die erop wordt aangesproken.' },
    required: true,
    answer: { type: 'yesNo' },
    becomes: { kind: 'role', about: 'respondent', relation: { yes: 'owner', no: 'notOwner' } },
  },
  {
    id: 'realOwner',
    text: { en: 'Who is the owner, then?', nl: 'Wie is dan de eigenaar?' },
    showWhen: { question: 'isOwner', equals: 'no' },
    answer: { type: 'person' },
    becomes: { kind: 'role', about: 'answer', relation: 'owner' },
  },
  {
    id: 'responsible',
    text: { en: 'Who does the day-to-day work for it?', nl: 'Wie doet het dagelijkse werk ervoor?' },
    help: { en: 'Leave empty when nobody does.', nl: 'Laat leeg als niemand dat doet.' },
    answer: { type: 'people' },
    becomes: { kind: 'role', about: 'answer', relation: 'dayToDay' },
  },
];

export const SEED_TEMPLATES = Object.freeze([
  {
    key: 'customer-check',
    name: 'Customer check',
    description: 'Is the customer active, who owns it, who does the work, and are the right people linked to it.',
    contextCategory: 'OrganizationalUnit',
    definition: {
      schemaVersion: 1,
      languages: ['en', 'nl'],
      title: { en: 'Customer check: {context}', nl: 'Klantcheck: {context}' },
      intro: {
        en: 'A few questions about {context}. Your answers are reviewed before anything is changed.',
        nl: 'Een paar vragen over {context}. Uw antwoorden worden beoordeeld voordat er iets verandert.',
      },
      sections: [
        {
          id: 'status',
          title: { en: 'Status', nl: 'Status' },
          questions: [{
            id: 'active',
            text: { en: 'Is {context} an active customer?', nl: 'Is {context} een actieve klant?' },
            required: true,
            answer: { type: 'yesNo' },
            becomes: { kind: 'property', attribute: 'activeCustomer' },
          }],
        },
        { id: 'ownership', title: { en: 'Ownership', nl: 'Eigenaarschap' }, questions: OWNER_QUESTIONS('customer', 'klant') },
        {
          id: 'people',
          title: { en: 'People', nl: 'Mensen' },
          questions: [{
            id: 'belongs',
            text: { en: 'Does this person work on {context}?', nl: 'Werkt deze persoon voor {context}?' },
            rows: { source: 'members', columns: ['displayName', 'jobTitle', 'department'] },
            answer: { type: 'yesNo' },
            becomes: { kind: 'membership', about: 'row', status: { yes: 'current', no: 'former' } },
          }],
        },
        {
          id: 'work',
          title: { en: 'What we do', nl: 'Wat we doen' },
          questions: [{
            id: 'whatWeDo',
            text: { en: 'What do we do for {context}?', nl: 'Wat doen we voor {context}?' },
            answer: { type: 'text', maxLength: 2000 },
            becomes: { kind: 'description' },
          }],
        },
      ],
    },
  },
  {
    key: 'application-intake',
    name: 'Application intake',
    description: 'Ownership, criticality and NIS2 relevance of a logical application.',
    contextCategory: 'LogicalApplication',
    definition: {
      schemaVersion: 1,
      languages: ['en', 'nl'],
      title: { en: 'Application intake: {context}', nl: 'Intake applicatie: {context}' },
      intro: {
        en: 'A few questions about the application {context}. Your answers are reviewed before anything is changed.',
        nl: 'Een paar vragen over de applicatie {context}. Uw antwoorden worden beoordeeld voordat er iets verandert.',
      },
      sections: [
        { id: 'ownership', title: { en: 'Ownership', nl: 'Eigenaarschap' }, questions: OWNER_QUESTIONS('application', 'de applicatie') },
        {
          id: 'classification',
          title: { en: 'Classification', nl: 'Classificatie' },
          questions: [
            {
              id: 'criticality',
              text: { en: 'How critical is {context}?', nl: 'Hoe kritiek is {context}?' },
              required: true,
              answer: {
                type: 'choice',
                options: [
                  { value: 'A', label: { en: 'A: business stops without it', nl: 'A: het bedrijf stopt zonder' } },
                  { value: 'B', label: { en: 'B: severe impact within a day', nl: 'B: grote impact binnen een dag' } },
                  { value: 'C', label: { en: 'C: impact within a week', nl: 'C: impact binnen een week' } },
                  { value: 'D', label: { en: 'D: little impact', nl: 'D: weinig impact' } },
                ],
              },
              becomes: { kind: 'property', attribute: 'criticality' },
            },
            {
              id: 'nis2',
              text: { en: 'Is {context} relevant for NIS2?', nl: 'Is {context} relevant voor NIS2?' },
              answer: { type: 'yesNo' },
              becomes: { kind: 'property', attribute: 'nis2Relevant' },
            },
            {
              id: 'purpose',
              text: { en: 'What is {context} used for?', nl: 'Waarvoor wordt {context} gebruikt?' },
              answer: { type: 'text', maxLength: 2000 },
              becomes: { kind: 'description' },
            },
          ],
        },
      ],
    },
  },
  {
    key: 'application-entitlement-review',
    name: 'Application entitlement review',
    description: 'Follow-up for an application: is each entitlement\'s owner and certification frequency right.',
    contextCategory: 'LogicalApplication',
    definition: {
      schemaVersion: 1,
      languages: ['en', 'nl'],
      title: { en: 'Entitlements of {context}', nl: 'Rechten van {context}' },
      intro: {
        en: 'For each entitlement of {context}: is what we have right? Say no and give the right value where it is not.',
        nl: 'Per recht van {context}: klopt wat wij hebben? Zeg nee en geef de juiste waarde waar het niet klopt.',
      },
      sections: [{
        id: 'entitlements',
        title: { en: 'Entitlements', nl: 'Rechten' },
        questions: [
          {
            id: 'entitlementOwner',
            text: { en: 'Is the owner of this entitlement right?', nl: 'Klopt de eigenaar van dit recht?' },
            rows: { source: 'resources', columns: ['displayName', 'resourceType', 'owner'] },
            answer: { type: 'confirm', shows: 'owner' },
            becomes: { kind: 'property', about: 'row', attribute: 'owner' },
          },
          {
            id: 'certificationFrequency',
            text: { en: 'Is the certification frequency right?', nl: 'Klopt de hercertificeringsfrequentie?' },
            rows: { source: 'resources', columns: ['displayName', 'certificationFrequency'] },
            answer: { type: 'confirm', shows: 'certificationFrequency' },
            becomes: { kind: 'property', about: 'row', attribute: 'certificationFrequency' },
          },
        ],
      }],
    },
  },
  {
    key: 'unit-roster',
    name: 'Unit roster',
    description: 'A manager confirms who works in the unit, their role and what they are responsible for.',
    contextCategory: 'OrganizationalUnit',
    definition: {
      schemaVersion: 1,
      languages: ['en', 'nl'],
      title: { en: 'Your team: {context}', nl: 'Uw team: {context}' },
      intro: {
        en: 'These are the people we have in {context}. For each: do they work for you, what is their role, and what are they responsible for?',
        nl: 'Dit zijn de mensen die wij in {context} hebben. Per persoon: werkt hij of zij voor u, wat is de rol, en waarvoor is hij of zij verantwoordelijk?',
      },
      sections: [{
        id: 'roster',
        title: { en: 'People', nl: 'Mensen' },
        questions: [
          {
            id: 'worksHere',
            text: { en: 'Works for you?', nl: 'Werkt voor u?' },
            required: true,
            rows: { source: 'members', columns: ['displayName', 'jobTitle', 'department'] },
            answer: { type: 'yesNo' },
            becomes: { kind: 'membership', about: 'row', status: { yes: 'current', no: 'former' } },
          },
          {
            id: 'role',
            text: { en: 'Role', nl: 'Rol' },
            rows: { source: 'members' },
            answer: { type: 'text', maxLength: 200 },
            becomes: { kind: 'role', about: 'row', relation: 'member' },
          },
          {
            id: 'responsibleFor',
            text: { en: 'Responsible for', nl: 'Verantwoordelijk voor' },
            rows: { source: 'members' },
            answer: { type: 'text', maxLength: 1000 },
            becomes: { kind: 'role', about: 'row', relation: 'other' },
          },
        ],
      }],
    },
  },
]);
