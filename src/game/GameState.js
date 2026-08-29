// =========================================================
//  GameState — Kanonik Oyun Modeli
//
//  KURAL: Oyunun tüm gerçeği bu nesnede yaşar.
//  Başka hiçbir yerde türetilmiş state tutulmaz.
//
//  Tasarım ilkeleri:
//  1. Index yok — her şey string ID ile referans edilir
//  2. Alt-objeler kendi bağlamında anlamlı (auction{}, battle{})
//  3. UI, state'i olduğu gibi okur; hesaplama yapmaz
//  4. JSON.stringify/parse güvenli — fonksiyon, class yok
//  5. Online: sunucudan gelen JSON bu şekle parse edilir
// =========================================================

import { START_BALANCE } from './animals.js';

// ─── ID Üreteci ───────────────────────────────────────────

/** Basit, taşınabilir ID üreteci. Online'da sunucu üretir. */
export function generateId(prefix = 'g') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Model Sabitleri ──────────────────────────────────────

export const PLAYER_IDS = ['player1', 'player2'];

export const STATUS = Object.freeze({
  WAITING:      'waiting',      // Lobi — oyuncu bekleniyor
  AUCTION:      'auction',      // Müzayede sürüyor
  FREE_CHOICE:  'free_choice',  // Rakip parasız — teklif verebilen taraf karar veriyor
  ROUND_RESULT: 'round_result', // Tur sonucu gösteriliyor
  COLLECTION:   'collection',   // Koleksiyonlar inceleniyor
  BATTLE:       'battle',       // Savaş sürüyor
  FINAL:        'final',        // Oyun bitti
});

// ─── Alt-Model Yapıcıları ─────────────────────────────────

/**
 * Tek bir oyuncu kaydı.
 * @param {string} id       — 'player1' | 'player2' (veya sunucu UUID)
 * @param {string} [name]   — Görünen ad (ileride)
 */
function makePlayer(id, name = `Oyuncu ${id === 'player1' ? 1 : 2}`) {
  return {
    id,
    name,
    balance: START_BALANCE,
    animals: [],   // [{ animalId, name, emoji, quantity, power:{attack,defense,speed,basePower},
                   //    rarity, boughtFor, round }]
  };
}

/**
 * Müzayede alt-modeli — sadece 'auction' statüsünde dolu.
 * null: müzayede aktif değil.
 */
function makeAuction(item, firstBidderId) {
  return {
    animalId:       item.animal.id,
    animalName:     item.animal.name,
    animalEmoji:    item.animal.emoji,
    animalRarity:   item.animal.rarity,
    animalPower:    {                          // UI: istatistikler için
      attack:    item.animal.attack,
      defense:   item.animal.defense,
      speed:     item.animal.speed,
      basePower: item.animal.basePower,
    },
    quantity:       item.quantity,
    currentBid:     null,   // { amount: number, bidderId: string } | null
    activeBidderId: firstBidderId,
  };
}

/**
 * Serbest-karar alt-modeli — sadece 'free_choice' statüsünde dolu.
 * Rakibin parası bittiğinde (ama envanterinde yeri varken) devreye girer:
 * teklif verebilen oyuncu, hayvanı BEDAVA alıp almayacağına ya da
 * doğrudan parasız rakibe (yine bedava) bırakacağına karar verir.
 */
function makeFreeChoice(item, deciderId, brokeId) {
  return {
    animalId:    item.animal.id,
    animalName:  item.animal.name,
    animalEmoji: item.animal.emoji,
    animalRarity: item.animal.rarity,
    animalPower: {
      attack:    item.animal.attack,
      defense:   item.animal.defense,
      speed:     item.animal.speed,
      basePower: item.animal.basePower,
    },
    quantity:  item.quantity,
    deciderId,   // teklif verebilen oyuncu — kararı o veriyor
    brokeId,     // parası biten oyuncu — pas edilirse hayvan ona gider
  };
}

/**
 * Tur sonucu alt-modeli — roundResult statüsünde dolu.
 */
function makeRoundResult({ item, winnerId, price, auto, reason, autoPassed }) {
  return {
    animalId:    item.animal.id,
    animalName:  item.animal.name,
    animalEmoji: item.animal.emoji,
    quantity:    item.quantity,
    winnerId,          // 'player1' | 'player2'
    price,             // ödenen TL
    auto:        !!auto,
    reason:      reason ?? null,     // 'opponent_cannot_bid' | 'both_broke' | null
    autoPassed:  autoPassed ?? false,
  };
}

/**
 * Savaş karşılaşma sonucu.
 */
export function makeBattleMatch({ matchIndex, p1Animal, p2Animal, r1, r2, winnerId }) {
  return {
    matchIndex,
    player1Animal: p1Animal,    // { animalId, name, emoji, quantity }
    player2Animal: p2Animal,
    player1Power:  r1,          // { basePart, flatPart, base, factorPct, final }
    player2Power:  r2,
    winnerId,                   // 'player1' | 'player2'
  };
}

/**
 * Savaş alt-modeli — sadece 'battle' statüsünde dolu.
 */
function makeBattle() {
  return {
    matchIndex:   0,            // 0–4
    revealed:     false,        // mevcut karşılaşma açıldı mı?
    currentMatch: null,         // makeBattleMatch sonucu | null
    matches:      [],           // tamamlanan BattleMatch[]
    scores: {
      player1: 0,
      player2: 0,
    },
  };
}

// ─── Kanonik Başlangıç State'i ────────────────────────────

/**
 * Yeni bir oyun state'i üretir.
 *
 * @param {string} [gameId]       — online'da sunucu verir; local'de otomatik
 * @param {Object} [playerNames]  — { player1: 'Ad', player2: 'Ad' }
 */
export function makeInitialState(gameId = generateId('game'), playerNames = {}) {
  return {
    gameId,
    status:      STATUS.WAITING,
    round:       0,             // 0–9 (10 tur)
    totalRounds: 10,

    players: {
      player1: makePlayer('player1', playerNames.player1),
      player2: makePlayer('player2', playerNames.player2),
    },

    // Müzayede kuyruğu — ham liste, UI'a açık değil.
    // Sadece engine okur. Sıradaki öğeye 'auction' üzerinden ulaşılır.
    _queue: [],                 // [{ animal, quantity }] — private (underscore konvansiyonu)

    auction:     null,          // makeAuction() | null
    freeChoice:  null,          // makeFreeChoice() | null
    roundResult: null,          // makeRoundResult() | null
    battle:      null,          // makeBattle() | null

    log: [],                    // string[] — insan okunabilir geçmiş
  };
}

// ─── State Yardımcıları (engine'ler kullanır) ─────────────

/** players objesini array'e çevirir — iterasyon için. */
export function playersArray(state) {
  return [state.players.player1, state.players.player2];
}

/** ID'ye göre oyuncu döndürür. */
export function getPlayer(state, playerId) {
  const p = state.players[playerId];
  if (!p) throw new Error(`Bilinmeyen oyuncu ID: ${playerId}`);
  return p;
}

/** Rakip ID'yi döndürür. */
export function opponentOf(playerId) {
  return playerId === 'player1' ? 'player2' : 'player1';
}

/** Geçerli tur öğesini döndürür (engine içi kullanım). */
export function currentQueueItem(state) {
  return state._queue[state.round];
}

/** Hem tur hem de kazanan için log satırı üretir. */
export function makeLogLine(round, result) {
  const animal = `${result.quantity} ${result.animalName}`;
  const winner = result.winnerId === 'player1' ? 'Oyuncu 1' : 'Oyuncu 2';
  if (result.auto) {
    const suffix = result.price > 0
      ? `(otomatik, ${result.price} TL)`
      : '(otomatik, ücretsiz)';
    return `Tur ${round + 1}: ${animal} → ${winner} ${suffix}`;
  }
  return `Tur ${round + 1}: ${animal} → ${winner} (${result.price} TL)`;
}

// Re-export alt-model yapıcılarını engine'ler kullanabilsin
export { makeAuction, makeFreeChoice, makeRoundResult, makeBattle };
