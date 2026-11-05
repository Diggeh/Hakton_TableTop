// Presentation fixtures only. Never applied to the network session store.
export const campaigns = [
  {
    id: 'salt',
    name: 'The Sunken Coast',
    system: 'D&D 5e',
    chapter: 'Chapter III · Beneath the tide',
    description:
      'The lighthouse at Greyhaven has gone dark. Beyond the breakwater, an old sanctuary waits beneath the sea.',
    scene: 'Drowned Sanctuary',
    sessions: 8,
  },
  {
    id: 'ash',
    name: 'Ashes of the North',
    system: 'D&D 5.5e',
    chapter: 'Chapter I · The long road',
    description:
      'A winter caravan, a missing envoy, and a road that no longer appears on any map.',
    scene: 'Northwatch Crossing',
    sessions: 2,
  },
];
export const party = [
  {
    name: 'Mira',
    detail: 'Half-elf ranger · Level 4',
    initials: 'MI',
    hp: 28,
    max: 32,
    ac: 15,
    color: '#adfcf9',
  },
  {
    name: 'Thorne',
    detail: 'Human paladin · Level 4',
    initials: 'TH',
    hp: 36,
    max: 36,
    ac: 18,
    color: '#d7cba0',
  },
  {
    name: 'Ilyra',
    detail: 'Tiefling wizard · Level 4',
    initials: 'IL',
    hp: 19,
    max: 24,
    ac: 12,
    color: '#b6bbdf',
  },
];
export const assets = {
  Scenes: ['Drowned Sanctuary', 'Greyhaven Docks', 'The Old Lighthouse'],
  Characters: ['Mira', 'Thorne', 'Ilyra'],
  Maps: ['Sanctuary floor plan', 'The Sunken Coast'],
  Props: ['Stone altar', 'Iron chest', 'Brazier'],
  Attachments: ['Letter from the keeper', 'Coastal chart'],
};
