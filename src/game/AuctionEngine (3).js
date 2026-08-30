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
  makeFreeChoice,
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
 *
 * - İkisi de teklif verebiliyorsa → normal müzayede.
 * - Sadece biri teklif veremiyorsa VE bunun sebebi PARASIZLIK ise (envanterinde
 *   hâlâ yeri var) → otomatik olarak hiç kimseye verilmez. Teklif verebilen
 *   oyuncuya bir SEÇİM ekranı açılır: 💰 Bedava al, ya da ✋ Pas geç (hayvanı
 *   parasız rakibe bırak).
 * - Sadece biri teklif veremiyorsa VE bunun sebebi envanterinin dolu olmasıysa
 *   (parasal değil — gerçekten katılamaz) → otomatik dağıtım.
 * - İkisi de teklif veremiyorsa → ücretsiz otomatik dağıtım.
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
  const p1 = state.players.player1;
  const p2 = state.players.player2;
  const room1  = p1.animals.length < 5;
  const room2  = p2.animals.length < 5;
  const canBid = (p) => p.balance >= 1 && p.animals.length < 5;
  const elig1  = canBid(p1);
  const elig2  = canBid(p2);

  // Normal müzayede — ikisi de teklif verebiliyor.
  if (elig1 && elig2) {
    const firstBidderId = startingBidder(state.round);
    const next = {
      ...state,
      status:      STATUS.AUCTION,
      auction:     makeAuction(item, firstBidderId),
      freeChoice:  null,
      roundResult: null,
    };
    return {
      state: next,
      event: { type: 'ROUND_STARTED', round: state.round, item, firstBidderId },
    };
  }

  // Sadece biri teklif verebiliyor.
  if (elig1 || elig2) {
    const deciderId       = elig1 ? 'player1' : 'player2';
    const brokeId         = opponentOf(deciderId);
    const brokeHasRoom    = deciderId === 'player1' ? room2 : room1;
    const brokeIsBroke    = state.players[brokeId].balance < 1;

    if (brokeHasRoom && brokeIsBroke) {
      // Rakip sadece parasız — otomatik dağıtım YOK. Teklif verebilen
      // oyuncuya karar ekranı açılır (bedava al / rakibe bırak).
      const next = {
        ...state,
        status:      STATUS.FREE_CHOICE,
        auction:     null,
        freeChoice:  makeFreeChoice(item, deciderId, brokeId),
        roundResult: null,
      };
      return {
        state: next,
        event: { type: 'FREE_CHOICE_STARTED', round: state.round, item, deciderId, brokeId },
      };
    }

    // Rakip gerçekten katılamıyor (envanteri dolu) → otomatik dağıtım.
    const resultData = { item, winnerId: deciderId, price: 1, auto: true, reason: 'opponent_cannot_bid' };
    const roundResult = makeRoundResult(resultData);
    const players = {
      ...state.players,
      [deciderId]: awardAnimal(state.players[deciderId], item, 1, state.round),
    };
    const next = {
      ...state,
      players,
      status:      STATUS.ROUND_RESULT,
      auction:     null,
      freeChoice:  null,
      roundResult,
      log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { state: next, event: { type: 'ITEM_AUTO_AWARDED', ...resultData } };
  }

  // İkisi de teklif veremiyor.
  const a1 = p1.animals.length;
  const a2 = p2.animals.length;
  const winnerId = a1 < a2 ? 'player1' : a2 < a1 ? 'player2' : startingBidder(state.round);
  const resultData = { item, winnerId, price: 0, auto: true, reason: 'both_broke' };
  const roundResult = makeRoundResult(resultData);
  const players = {
    ...state.players,
    [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round),
  };
  const next = {
    ...state,
    players,
    status:      STATUS.ROUND_RESULT,
    auction:     null,
    freeChoice:  null,
    roundResult,
    log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { state: next, event: { type: 'ITEM_AUTO_AWARDED', ...resultData } };
}

// ─── Serbest Karar (rakip parasız) ─────────────────────────

/**
 * Teklif verebilen oyuncu, parasız rakip karşısında kararını verir.
 *
 * @param {GameState} state
 * @param {string}    deciderId — kararı veren oyuncu
 * @param {'take'|'pass'} choice
 * @returns {{ ok, state, event?, error? }}
 */
export function chooseFreeItem(state, deciderId, choice) {
  if (state.status !== STATUS.FREE_CHOICE) {
    return { ok: false, state, error: 'Karar aşaması aktif değil.' };
  }
  if (!state.freeChoice || state.freeChoice.deciderId !== deciderId) {
    return { ok: false, state, error: 'Bu karar sana ait değil.' };
  }
  if (choice !== 'take' && choice !== 'pass') {
    return { ok: false, state, error: `Geçersiz seçim: ${choice}` };
  }

  const { brokeId } = state.freeChoice;
  const winnerId = choice === 'take' ? deciderId : brokeId;
  const item     = currentQueueItem(state);

  const resultData = {
    item, winnerId, price: 0, auto: false,
    reason: choice === 'take' ? 'free_choice_taken' : 'free_choice_passed',
  };
  const roundResult = makeRoundResult(resultData);
  const players = {
    ...state.players,
    [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round),
  };
  const next = {
    ...state,
    players,
    status:      STATUS.ROUND_RESULT,
    freeChoice:  null,
    roundResult,
    log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { ok: true, state: next, event: { type: 'FREE_ITEM_DECIDED', ...resultData } };
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
 * Pas geçme.
 *
 * İki senaryo:
 * 1. Ortada bir teklif VARKEN pas: klasik akış — teklif sahibi kazanır,
 *    tur biter. (Örn. bir oyuncu diğerinin teklifini geçemeyeceğine
 *    karar verip vazgeçtiğinde.)
 * 2. Ortada HİÇ teklif YOKKEN pas: oyuncu ilk teklifi vermek istemiyor.
 *    Bu, sunucudaki "bid timer" zaman aşımında da otomatik tetiklenir
 *    (bkz. RoomManager#autoPassAuction) — bağlı ama pasif kalan oyuncuyu
 *    sonsuza kadar beklememek için. Sıra rakibe geçer. Rakip de daha
 *    önce teklifsiz pas geçtiyse (ikisi de bu öğeyi istemiyor), öğe
 *    otomatik dağıtılır (envanteri az olan taraf kazanır, ücretsiz).
 *
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

  const { auction } = state;
  const item = currentQueueItem(state);

  // ── Teklif VARKEN pas: mevcut teklif sahibi kazanır ──────────────
  if (auction.currentBid) {
    const winnerId = auction.currentBid.bidderId;
    const price    = auction.currentBid.amount;
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

  // ── Teklif YOKKEN pas: sırayı rakibe devret ───────────────────────
  const opponentId = opponentOf(passerId);

  if (auction.firstPasserId && auction.firstPasserId !== passerId) {
    // Rakip de daha önce teklifsiz pas geçmişti — kimse bu öğeyi
    // istemiyor. "both_broke" ile aynı mantıkla otomatik dağıtım:
    // envanteri az olan taraf kazanır, eşitse tur sırası belirler.
    const p1 = state.players.player1;
    const p2 = state.players.player2;
    const winnerId = p1.animals.length < p2.animals.length ? 'player1'
                   : p2.animals.length < p1.animals.length ? 'player2'
                   : startingBidder(state.round);
    const resultData  = { item, winnerId, price: 0, auto: true, reason: 'both_declined' };
    const roundResult = makeRoundResult(resultData);
    const players = {
      ...state.players,
      [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round),
    };
    const next = {
      ...state,
      players,
      status:      STATUS.ROUND_RESULT,
      auction:     null,
      roundResult,
      log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { ok: true, state: next, event: { type: 'ITEM_DECLINED_BY_BOTH', ...resultData } };
  }

  const next = {
    ...state,
    auction: { ...auction, activeBidderId: opponentId, firstPasserId: passerId },
  };
  return {
    ok:    true,
    state: next,
    event: { type: 'BIDDER_PASSED_NO_BID', passerId, nextBidderId: opponentId },
  };
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
