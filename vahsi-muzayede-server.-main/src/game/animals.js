// =========================================================
//  DATA — Hayvan Veritabanı
// =========================================================

export const START_BALANCE = 20;

export const RARITY = {
  common:    { label: 'Common',    color: '#93A69C' },
  uncommon:  { label: 'Uncommon',  color: '#8FBF4F' },
  rare:      { label: 'Rare',      color: '#4FA0E8' },
  epic:      { label: 'Epic',      color: '#B07BE8' },
  legendary: { label: 'Legendary', color: '#E8B23D' },
};

export const ANIMALS = [
  { id: 'fil',      name: 'Fil',           emoji: '🐘',  rarity: 'rare',      basePower: 8, attack: 5, defense: 9, speed: 3,  qty: [3, 8] },
  { id: 'aslan',    name: 'Aslan',         emoji: '🦁',  rarity: 'epic',      basePower: 7, attack: 9, defense: 5, speed: 6,  qty: [2, 5] },
  { id: 'kaplan',   name: 'Kaplan',        emoji: '🐯',  rarity: 'epic',      basePower: 7, attack: 9, defense: 5, speed: 7,  qty: [2, 5] },
  { id: 'goril',    name: 'Goril',         emoji: '🦍',  rarity: 'rare',      basePower: 7, attack: 7, defense: 7, speed: 4,  qty: [3, 8] },
  { id: 'suaygiri', name: 'Su Aygırı',     emoji: '🦛',  rarity: 'rare',      basePower: 8, attack: 6, defense: 8, speed: 2,  qty: [3, 8] },
  { id: 'gergedan', name: 'Gergedan',      emoji: '🦏',  rarity: 'rare',      basePower: 8, attack: 7, defense: 9, speed: 3,  qty: [3, 8] },
  { id: 'timsah',   name: 'Timsah',        emoji: '🐊',  rarity: 'uncommon',  basePower: 6, attack: 7, defense: 6, speed: 3,  qty: [4, 10] },
  { id: 'kurt',     name: 'Kurt',          emoji: '🐺',  rarity: 'common',    basePower: 5, attack: 6, defense: 3, speed: 7,  qty: [6, 15] },
  { id: 'ayi',      name: 'Ayı',           emoji: '🐻',  rarity: 'uncommon',  basePower: 7, attack: 6, defense: 6, speed: 4,  qty: [4, 10] },
  { id: 'boga',     name: 'Boğa',          emoji: '🐂',  rarity: 'common',    basePower: 6, attack: 6, defense: 5, speed: 5,  qty: [6, 15] },
  { id: 'cita',     name: 'Çita',          emoji: '🐈',  rarity: 'uncommon',  basePower: 4, attack: 7, defense: 2, speed: 10, qty: [4, 10] },
  { id: 'sirtlan',  name: 'Sırtlan',       emoji: '🐕',  rarity: 'common',    basePower: 4, attack: 5, defense: 3, speed: 6,  qty: [6, 15] },
  { id: 'zebra',    name: 'Zebra',         emoji: '🦓',  rarity: 'common',    basePower: 3, attack: 3, defense: 4, speed: 8,  qty: [6, 15] },
  { id: 'bufalo',   name: 'Bufalo',        emoji: '🐃',  rarity: 'uncommon',  basePower: 7, attack: 6, defense: 7, speed: 3,  qty: [4, 10] },
  { id: 'deve',     name: 'Deve',          emoji: '🐪',  rarity: 'common',    basePower: 4, attack: 3, defense: 5, speed: 4,  qty: [6, 15] },
  { id: 'kanguru',  name: 'Kanguru',       emoji: '🦘',  rarity: 'uncommon',  basePower: 5, attack: 6, defense: 3, speed: 7,  qty: [4, 10] },
  { id: 'bizon',    name: 'Bizon',         emoji: '🦬',  rarity: 'rare',      basePower: 8, attack: 6, defense: 7, speed: 4,  qty: [3, 8] },
  { id: 'jaguar',   name: 'Jaguar',        emoji: '🐈\u200d⬛', rarity: 'epic', basePower: 6, attack: 8, defense: 5, speed: 7, qty: [2, 5] },
  { id: 'leopar',   name: 'Leopar',        emoji: '🐆',  rarity: 'epic',      basePower: 6, attack: 8, defense: 4, speed: 8,  qty: [2, 5] },
  { id: 'komodo',   name: 'Komodo Ejderi', emoji: '🦎',  rarity: 'legendary', basePower: 7, attack: 8, defense: 6, speed: 3,  qty: [1, 3] },
];
