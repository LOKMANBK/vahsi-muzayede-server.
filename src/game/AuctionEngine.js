// =========================================================
//  AUCTION ENGINE
//  Yeni kanonik model üzerinde çalışır.
//  players array değil object — ID ile erişilir.
// =========================================================

import { ANIMALS } from './animals.js';
import {
  STATUS,
  PLAYER_IDS,
  getPlayer,
  opponentOf,
  playersArray,
  currentQueueItem,
  makeAuction,
  makeRoundResult,
  makeLogLine,
} from './GameState.js';

// ─── Yardımcılar ──────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Turdaki başlangıç teklif sırasını belirler (dönüşümlü). */
function startingBidder(round) {
  return round % 2 === 0 ? PLAYER_IDS[0] : PLAYER_IDS[1];
}

/** Kazanan hayvanı oyuncunun koleksiyonuna ekler. */
function awardAnimal(player, item, price, round) {
  const entry = {
    animalId:  item.animal.id,
    name:      item.animal.name,
    emoji:     item.animal.emoji,
    rarity:    item.animal.rarity,
    quantity:  item.quantity,
    power: {
      attack:    item.animal.attack,
      defense:   item.animal.defense,
      speed:     item.animal.speed,
      basePower: item.animal.basePower,
    },
    boughtFor: price,
    round,
  };
  return {
    ...player,
    balance: player.balance - price,
    animals: [...player.animals, entry],
  };
}

// ─── Kuyruk Oluşturma ─────────────────────────────────────

/**
 * 10 rastgele müzayede öğesi üretir.
 * @returns {Array<{ animal, quantity }>}
 */
export function buildQueue() {
  return shuffle(ANIMALS).slice(0, 10).map((animal) => ({
    animal,
    quantity: randInt(animal.qty[0], animal.qty[1]),
  }));
}

// ─── Tur Başlatma ─────────────────────────────────────────

/**
 * Bir sonraki turu başlatır.
 * Her iki oyuncu da müzayedeye katılabiliyorsa auction açar.
 * Biriyse/ikisi de yoksa otomatik dağıtır.
 *
 * @param   {GameState} state
 * @returns {{ state: GameState, event: GameEvent }}
 */
export function beginRound(state) {
  if (state.round >= state.totalRounds) {
    const next = { ...state, status: STATUS.COLLECTION, auction: null };
    return { state: next, event: { type: 'COLLECTION_PHASE_STARTED' } };
  }

  const item = currentQueueItem(state);
  const canBid = (p) => p.balance >= 1 && p.animals.length < 5;
  const elig1 = canBid(state.players.player1);
  const elig2 = canBid(state.players.player2);

  // Normal müzayede
  if (elig1 && elig2) {
    const firstBidderId = startingBidder(state.round);
    const next = {
      ...state,
      status:      STATUS.AUCTION,
      auction:     makeAuction(item, firstBidderId),
      roundResult: null,
    };
    return {
      state: next,
      event: { type: 'ROUND_STARTED', round: state.round, item, firstBidderId },
    };
  }

  // Otomatik dağıtım
  let winnerId, price, reason;
  if (elig1 || elig2) {
    winnerId = elig1 ? 'player1' : 'player2';
    price    = 1;
    reason   = 'opponent_cannot_bid';
  } else {
    const a1 = state.players.player1.animals.length;
    const a2 = state.players.player2.animals.length;
    winnerId = a1 < a2 ? 'player1' : a2 < a1 ? 'player2' : startingBidder(state.round);
    price    = 0;
    reason   = 'both_broke';
  }

  const resultData = { item, winnerId, price, auto: true, reason };
  const roundResult = makeRoundResult(resultData);
  const players = {
    ...state.players,
    [winnerId]: awardAnimal(state.players[winnerId], item, price, state.round),
  };
  const next = {
    ...state,
    players,
    status:      STATUS.ROUND_RESULT,
    auction:     null,
    roundResult,
    log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { state: next, event: { type: 'ITEM_AUTO_AWARDED', ...resultData } };
}

// ─── Teklif Verme ─────────────────────────────────────────

/**
 * @param {GameState} state
 * @param {string}    bidderId  — 'player1' | 'player2'
 * @param {number}    amount
 * @returns {{ ok, state, event?, error? }}
 */
export function placeBid(state, bidderId, amount) {
  if (state.status !== STATUS.AUCTION) {
    return { ok: false, state, error: 'Müzayede aktif değil.' };
  }
  if (!state.players[bidderId]) {
    return { ok: false, state, error: `Bilinmeyen oyuncu: ${bidderId}` };
  }
  if (state.auction.activeBidderId !== bidderId) {
    return { ok: false, state, error: 'Sıra sende değil.' };
  }

  const { auction } = state;
  const minBid  = auction.currentBid ? auction.currentBid.amount + 1 : 1;
  const balance = state.players[bidderId].balance;

  if (amount < minBid)  return { ok: false, state, error: `Minimum teklif ${minBid} TL.` };
  if (amount > balance) return { ok: false, state, error: 'Yetersiz bakiye.' };

  const opponentId      = opponentOf(bidderId);
  const opponentBalance = state.players[opponentId].balance;
  const newBid          = { amount, bidderId };

  // Rakip geçemez → müzayede biter
  if (opponentBalance < amount + 1) {
    const item   = currentQueueItem(state);
    const resultData = { item, winnerId: bidderId, price: amount, auto: false, autoPassed: true };
    const roundResult = makeRoundResult(resultData);
    const players = {
      ...state.players,
      [bidderId]: awardAnimal(state.players[bidderId], item, amount, state.round),
    };
    const next = {
      ...state,
      players,
      status:      STATUS.ROUND_RESULT,
      auction:     { ...auction, currentBid: newBid },
      roundResult,
      log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { ok: true, state: next, event: { type: 'ITEM_WON_AUTO_PASS', ...resultData } };
  }

  // Normal teklif — sıra rakibe geçer
  const next = {
    ...state,
    auction: { ...auction, currentBid: newBid, activeBidderId: opponentId },
  };
  return {
    ok:    true,
    state: next,
    event: { type: 'BID_PLACED', bidderId, amount, nextBidderId: opponentId },
  };
}

// ─── Pas Geçme ────────────────────────────────────────────

/**
 * @param {GameState} state
 * @param {string}    passerId  — 'player1' | 'player2'
 * @returns {{ ok, state, event?, error? }}
 */
export function pass(state, passerId) {
  if (state.status !== STATUS.AUCTION) {
    return { ok: false, state, error: 'Müzayede aktif değil.' };
  }
  if (!state.players[passerId]) {
    return { ok: false, state, error: `Bilinmeyen oyuncu: ${passerId}` };
  }
  if (state.auction.activeBidderId !== passerId) {
    return { ok: false, state, error: 'Sıra sende değil.' };
  }
  if (!state.auction.currentBid) {
    return { ok: false, state, error: 'Pas geçmek için önce bir teklif olmalı.' };
  }

  const { currentBid } = state.auction;
  const winnerId = currentBid.bidderId;
  const price    = currentBid.amount;
  const item     = currentQueueItem(state);
  const resultData  = { item, winnerId, price, auto: false };
  const roundResult = makeRoundResult(resultData);
  const players = {
    ...state.players,
    [winnerId]: awardAnimal(state.players[winnerId], item, price, state.round),
  };
  const next = {
    ...state,
    players,
    status:      STATUS.ROUND_RESULT,
    auction:     null,
    roundResult,
    log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { ok: true, state: next, event: { type: 'ITEM_WON_BY_PASS', ...resultData } };
}

// ─── Tur İlerletme ────────────────────────────────────────

/**
 * roundResult onaylandıktan sonra sonraki tura geçer.
 * @param {GameState} state
 * @returns {{ state: GameState, event: GameEvent }}
 */
export function advanceRound(state) {
  const advanced = { ...state, round: state.round + 1, roundResult: null };
  return beginRound(advanced);
}
