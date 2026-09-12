// =========================================================
//  GameState4P.js — 4 Kişilik Mod Kanonik Model
//
//  3 kişilik GameState3P.js'e PARALEL, ayrı bir dosya. Mevcut 2P/3P
//  motorlarına dokunulmaz — bu bilinçli bir tasarım kararıdır (regresyon
//  riskini sıfırlar). Kural referansları: 4_kisilik_mod_kurallari.md v2.
// =========================================================

export const PLAYER_IDS    = ['player1', 'player2', 'player3', 'player4'];
export const START_BALANCE = 40;              // Kural 3
export const ANIMAL_LIMIT  = 5;               // Kural 2
export const TOTAL_ROUNDS  = 20;              // Kural 4 (5 × 4)

export const STATUS = Object.freeze({
  WAITING:      'waiting',
  AUCTION:      'auction',
  FREE_CHOICE:  'free_choice',
  ROUND_RESULT: 'round_result',
  COLLECTION:   'collection',
  BATTLE:       'battle',
  FINAL:        'final',
});

export function generateId(prefix = 'g4') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Alt-Model Yapıcıları ─────────────────────────────────

function makePlayer(id, name) {
  return {
    id,
    name: name || `Oyuncu ${id.slice(-1)}`,
    balance:    START_BALANCE,
    animals:    [],
    forfeited:  false,   // Kural 9, 34
  };
}

/** Kural: auction.passedIds — bu turda pas geçenler (kalıcı sadece bu tur için). */
function makeAuction(item, firstBidderId) {
  return {
    animalId:       item.animal.id,
    animalName:     item.animal.name,
    animalEmoji:    item.animal.emoji,
    animalRarity:   item.animal.rarity,
    animalPower: {
      attack: item.animal.attack, defense: item.animal.defense,
      speed:  item.animal.speed,  basePower: item.animal.basePower,
    },
    quantity:       item.quantity,
    currentBid:     null,           // { amount, bidderId } | null
    activeBidderId: firstBidderId,
    passedIds:      [],             // Kural 21 — bu tur için kalıcı
  };
}

/**
 * giftCandidateIds — Kural 27: hediye edilebilecek adaylar (yeri olan
 * parasız oyuncular). 4P'de bu liste 1, 2 veya 3 oyuncu içerebilir
 * (3P'de en fazla 2'ydi) — bu yapıcı fonksiyon bu sayıya duyarsızdır,
 * UI tarafı listeyi bir dropdown/seçim listesi olarak sunmalı.
 */
function makeFreeChoice(item, deciderId, giftCandidateIds) {
  return {
    animalId:      item.animal.id,
    animalName:    item.animal.name,
    animalEmoji:   item.animal.emoji,
    animalRarity:  item.animal.rarity,
    animalPower: {
      attack: item.animal.attack, defense: item.animal.defense,
      speed:  item.animal.speed,  basePower: item.animal.basePower,
    },
    quantity:  item.quantity,
    deciderId,
    giftCandidateIds,
  };
}

function makeRoundResult({ item, winnerId, price, auto, reason }) {
  return {
    animalId:    item.animal.id,
    animalName:  item.animal.name,
    animalEmoji: item.animal.emoji,
    quantity:    item.quantity,
    winnerId,
    price,
    auto:   !!auto,
    reason: reason ?? null,
  };
}

export function makeBattleMatch({ matchIndex, animalsByPlayer, powersByPlayer, pointsByPlayer, rankedIds }) {
  return { matchIndex, animalsByPlayer, powersByPlayer, pointsByPlayer, rankedIds };
}

function makeBattle() {
  const scores = {};
  PLAYER_IDS.forEach((id) => { scores[id] = 0; });
  return { matchIndex: 0, revealed: false, currentMatch: null, matches: [], scores };
}

// ─── Kanonik Başlangıç State'i ────────────────────────────

export function makeInitialState(gameId = generateId('game4'), playerNames = {}) {
  const players = {};
  PLAYER_IDS.forEach((id) => { players[id] = makePlayer(id, playerNames[id]); });

  return {
    gameId,
    mode:        '4p',
    status:      STATUS.WAITING,
    round:       0,
    totalRounds: TOTAL_ROUNDS,
    players,
    _queue: [],                 // private — GameEngine4P.getState() ile çıkarılır
    auction:     null,
    freeChoice:  null,
    roundResult: null,
    battle:      null,
    log: [],
    matchEndedEarly: false,     // Kural 14 — true olursa savaş atlanır
  };
}

// ─── State Yardımcıları ────────────────────────────────────

export function playersArray(state) {
  return PLAYER_IDS.map((id) => state.players[id]);
}

export function getPlayer(state, playerId) {
  const p = state.players[playerId];
  if (!p) throw new Error(`Bilinmeyen oyuncu ID: ${playerId}`);
  return p;
}

/** Belirtilen oyuncu dışındaki tüm oyuncu ID'leri. */
export function otherPlayers(playerId) {
  return PLAYER_IDS.filter((id) => id !== playerId);
}

export function currentQueueItem(state) {
  return state._queue[state.round];
}

/**
 * Kural 6-9: Oyuncu durumu. Tur başında sabitlenir.
 * NOT (Bölüm B notu): Kural 20'deki anlık ödeme gücü kontrolünden farklıdır —
 * bu fonksiyon oyuncunun GENEL kategorisini döner, bir turun ortasındaki
 * geçici ödeyemezlik durumunu YANSITMAZ. Kural 20'nin zorunlu kıldığı
 * anlık kontrol AuctionEngine4P.placeBid içinde ayrıca yapılır.
 */
export function playerStatus(player) {
  if (player.forfeited) return 'forfeited';
  if (player.animals.length >= ANIMAL_LIMIT) return 'dolu';
  if (player.balance >= 1) return 'aktif';
  return 'parasiz_yeri_var';
}

export function activeIds(state) {
  return PLAYER_IDS.filter((id) => playerStatus(state.players[id]) === 'aktif');
}

export function brokeWithRoomIds(state) {
  return PLAYER_IDS.filter((id) => playerStatus(state.players[id]) === 'parasiz_yeri_var');
}

export function nonForfeitedIds(state) {
  return PLAYER_IDS.filter((id) => !state.players[id].forfeited);
}

export function makeLogLine(round, result) {
  const animal = `${result.quantity} ${result.animalName}`;
  const winnerName = `Oyuncu ${result.winnerId.slice(-1)}`;
  if (result.auto) {
    const suffix = result.price > 0 ? `(otomatik, ${result.price} TL)` : '(otomatik, ücretsiz)';
    return `Tur ${round + 1}: ${animal} → ${winnerName} ${suffix}`;
  }
  return `Tur ${round + 1}: ${animal} → ${winnerName} (${result.price} TL)`;
}

export { makeAuction, makeFreeChoice, makeRoundResult, makeBattle };
