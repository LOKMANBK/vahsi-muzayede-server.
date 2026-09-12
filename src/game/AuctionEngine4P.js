// =========================================================
//  AuctionEngine4P.js — 4 Kişilik Müzayede Motoru
//
//  Kural referansları: 4_kisilik_mod_kurallari.md v2, Bölüm C-G.
// =========================================================

import { ANIMALS } from './animals.js';
import {
  STATUS, PLAYER_IDS,
  otherPlayers, activeIds, brokeWithRoomIds, nonForfeitedIds,
  currentQueueItem, playerStatus,
  makeAuction, makeFreeChoice, makeRoundResult, makeLogLine,
} from './GameState4P.js';
import { computeFinalRanking } from './BattleEngine4P.js';

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

/** Kural 5: 20 rastgele müzayede öğesi üretir. */
export function buildQueue() {
  return shuffle(ANIMALS).slice(0, 20).map((animal) => ({
    animal,
    quantity: randInt(animal.qty[0], animal.qty[1]),
  }));
}

function awardAnimal(player, item, price, round) {
  const entry = {
    animalId: item.animal.id, name: item.animal.name, emoji: item.animal.emoji,
    rarity: item.animal.rarity, quantity: item.quantity,
    power: {
      attack: item.animal.attack, defense: item.animal.defense,
      speed: item.animal.speed, basePower: item.animal.basePower,
    },
    boughtFor: price, round,
  };
  return { ...player, balance: player.balance - price, animals: [...player.animals, entry] };
}

/** Kural 16/30: tur_no % 4 ile başlayıp uygun (aktif ya da parasız-yeri-var) ilk oyuncuyu bulur. */
function firstMatching(state, predicate) {
  const startIdx = state.round % PLAYER_IDS.length;
  for (let i = 0; i < PLAYER_IDS.length; i++) {
    const candidate = PLAYER_IDS[(startIdx + i) % PLAYER_IDS.length];
    if (predicate(candidate)) return candidate;
  }
  return null;
}

/** Kural 11: müzayede fazının bitiş koşulu. */
function auctionPhaseShouldEnd(state) {
  if (state.round >= state.totalRounds) return true;
  const remaining = nonForfeitedIds(state);
  if (remaining.length === 0) return true; // Kural 12 (bkz. not — pratikte erişilemez, Kural 14 önce yakalar)
  return remaining.every((id) => playerStatus(state.players[id]) === 'dolu');
}

// ─── Tur Başlatma ─────────────────────────────────────────

/**
 * Gerçek çalışma sırası dokümandaki kavramsal sıradan (10→11→14) farklıdır —
 * doküman notunda da belirtildiği gibi kod her zaman ÖNCE Kural 14 (erken
 * bitiş), SONRA Kural 11 (faz bitişi), EN SON Kural 10 (aktif sayısına göre
 * dallanma) sırasıyla çalışır. Bu sıra 3P'den birebir miras alınmıştır.
 */
export function beginRound(state) {
  // Kural 14 — ayrılmamış oyuncu sayısı 1'e düştüyse maç anında biter.
  const remaining = nonForfeitedIds(state);
  if (remaining.length <= 1) {
    const next = { ...state, status: STATUS.FINAL, matchEndedEarly: true, auction: null };
    // Final sıralaması burada hesaplanıp state'e yazılır — client'a ayrıca
    // göndermezsek sırayı hiç gösteremez (tiebreak rastgele olduğu için
    // client kendi başına güvenilir biçimde tekrar hesaplayamaz).
    const finalRanking = computeFinalRanking(next);
    const withRanking = { ...next, finalRanking };
    return { state: withRanking, event: { type: 'MATCH_ENDED_EARLY', reason: 'not_enough_players', remaining, finalRanking } };
  }

  if (auctionPhaseShouldEnd(state)) {
    const next = { ...state, status: STATUS.COLLECTION, auction: null };
    return { state: next, event: { type: 'COLLECTION_PHASE_STARTED' } };
  }

  const item   = currentQueueItem(state);
  const active = activeIds(state);

  // Kural 10 — 2, 3 veya 4 aktif → müzayede (bu dal aktif sayısına duyarsızdır)
  if (active.length >= 2) {
    const firstBidderId = firstMatching(state, (id) => active.includes(id));
    const next = {
      ...state, status: STATUS.AUCTION, auction: makeAuction(item, firstBidderId),
      freeChoice: null, roundResult: null,
    };
    return { state: next, event: { type: 'ROUND_STARTED', round: state.round, item, firstBidderId } };
  }

  // Kural 10 — tam 1 aktif → serbest seçim
  if (active.length === 1) {
    const deciderId = active[0];
    const others    = otherPlayers(deciderId);
    const broke     = brokeWithRoomIds(state);
    // Kural 27 — 4P'de bu liste 1, 2 veya 3 oyuncu içerebilir (3P'de en
    // fazla 2'ydi). Bu satır sayıya duyarsızdır, doğal olarak genellenir.
    const giftCandidateIds = others.filter((id) => broke.includes(id));

    if (giftCandidateIds.length === 0) {
      // Kural 25 — diğer üçü de dolu/ayrılmış → otomatik 1 TL
      const resultData  = { item, winnerId: deciderId, price: 1, auto: true, reason: 'sole_active_auto' };
      const roundResult = makeRoundResult(resultData);
      const players = { ...state.players, [deciderId]: awardAnimal(state.players[deciderId], item, 1, state.round) };
      const next = {
        ...state, players, status: STATUS.ROUND_RESULT, auction: null, freeChoice: null,
        roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
      };
      return { state: next, event: { type: 'ITEM_AUTO_AWARDED', ...resultData } };
    }

    // Kural 26 — en az biri parasız-yeri-var → seçim ekranı
    const next = {
      ...state, status: STATUS.FREE_CHOICE, auction: null,
      freeChoice: makeFreeChoice(item, deciderId, giftCandidateIds), roundResult: null,
    };
    return { state: next, event: { type: 'FREE_CHOICE_STARTED', round: state.round, item, deciderId, giftCandidateIds } };
  }

  // Kural 10/29 — 0 aktif → otomatik dağıtım
  const brokeIds = brokeWithRoomIds(state);
  // Kural 31 garantisi: Kural 11 sayesinde buraya yalnızca brokeIds doluyken düşülür.
  const minCount = Math.min(...brokeIds.map((id) => state.players[id].animals.length));
  const eligibleAtMin = brokeIds.filter((id) => state.players[id].animals.length === minCount);
  const winnerId = firstMatching(state, (id) => eligibleAtMin.includes(id)); // Kural 30

  const resultData  = { item, winnerId, price: 0, auto: true, reason: 'zero_active_auto' };
  const roundResult = makeRoundResult(resultData);
  const players = { ...state.players, [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round) };
  const next = {
    ...state, players, status: STATUS.ROUND_RESULT, auction: null, freeChoice: null,
    roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { state: next, event: { type: 'ITEM_AUTO_AWARDED', ...resultData } };
}

// ─── Serbest Seçim (AL / HEDİYE ET) ────────────────────────

/**
 * Kural 26: AL = 1 TL, HEDİYE ET = bedava.
 * @param {'take'|'gift'} choice
 * @param {string|null} giftTargetId — choice==='gift' ise zorunlu, giftCandidateIds içinde olmalı
 */
export function chooseFreeItem(state, deciderId, choice, giftTargetId = null) {
  if (state.status !== STATUS.FREE_CHOICE) {
    return { ok: false, state, error: 'Karar aşaması aktif değil.' };
  }
  if (!state.freeChoice || state.freeChoice.deciderId !== deciderId) {
    return { ok: false, state, error: 'Bu karar sana ait değil.' };
  }

  const item = currentQueueItem(state);

  if (choice === 'take') {
    const price = 1; // Kural 26
    const resultData  = { item, winnerId: deciderId, price, auto: false, reason: 'free_choice_take' };
    const roundResult = makeRoundResult(resultData);
    const players = { ...state.players, [deciderId]: awardAnimal(state.players[deciderId], item, price, state.round) };
    const next = {
      ...state, players, status: STATUS.ROUND_RESULT, freeChoice: null,
      roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { ok: true, state: next, event: { type: 'FREE_ITEM_DECIDED', ...resultData } };
  }

  if (choice === 'gift') {
    // Kural 27 — 4P'de giftCandidateIds 1-3 aday içerebilir; hedef bunlardan
    // biri OLMAK ZORUNDADIR (decider'ın rastgele bir oyuncuya değil, yalnızca
    // gerçekten parasız-yeri-olan bir adaya hediye edebilmesini garanti eder).
    if (!giftTargetId || !state.freeChoice.giftCandidateIds.includes(giftTargetId)) {
      return { ok: false, state, error: 'Geçersiz hediye hedefi.' };
    }
    const resultData  = { item, winnerId: giftTargetId, price: 0, auto: false, reason: 'free_choice_gift' };
    const roundResult = makeRoundResult(resultData);
    const players = { ...state.players, [giftTargetId]: awardAnimal(state.players[giftTargetId], item, 0, state.round) };
    const next = {
      ...state, players, status: STATUS.ROUND_RESULT, freeChoice: null,
      roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { ok: true, state: next, event: { type: 'FREE_ITEM_DECIDED', ...resultData } };
  }

  return { ok: false, state, error: `Geçersiz seçim: ${choice}` };
}

// ─── Teklif Verme ─────────────────────────────────────────

export function placeBid(state, bidderId, amount) {
  if (state.status !== STATUS.AUCTION) return { ok: false, state, error: 'Müzayede aktif değil.' };
  if (!state.players[bidderId])        return { ok: false, state, error: `Bilinmeyen oyuncu: ${bidderId}` };
  if (state.auction.activeBidderId !== bidderId) return { ok: false, state, error: 'Sıra sende değil.' };

  const { auction } = state;
  const minBid  = auction.currentBid ? auction.currentBid.amount + 1 : 1;
  const balance = state.players[bidderId].balance;

  if (amount < minBid)  return { ok: false, state, error: `Minimum teklif ${minBid} TL.` };
  if (amount > balance) return { ok: false, state, error: 'Yetersiz bakiye.' };

  const newBid = { amount, bidderId };
  const updatedAuction = { ...auction, currentBid: newBid };
  const nextBidderId = nextBidderAfter(state, bidderId, updatedAuction);

  if (nextBidderId === null) {
    // Kural 23 — kimse kalmadı, teklif sahibi kazanır
    return resolveAuctionWin(state, bidderId, amount);
  }

  const next = { ...state, auction: { ...updatedAuction, activeBidderId: nextBidderId } };
  return { ok: true, state: next, event: { type: 'BID_PLACED', bidderId, amount, nextBidderId } };
}

// ─── Pas Geçme ────────────────────────────────────────────

/**
 * Kural 17 (zorunlu açılış teklifi yok) + Kural 21 (pas = o tur için kalıcı çıkış).
 */
export function pass(state, passerId) {
  if (state.status !== STATUS.AUCTION) return { ok: false, state, error: 'Müzayede aktif değil.' };
  if (state.auction.activeBidderId !== passerId) return { ok: false, state, error: 'Sıra sende değil.' };

  const { auction } = state;
  const updatedAuction = { ...auction, passedIds: [...auction.passedIds, passerId] };
  const nextBidderId = nextBidderAfter(state, passerId, updatedAuction);

  if (nextBidderId === null) {
    if (auction.currentBid) {
      // Kural 23
      return resolveAuctionWin(state, auction.currentBid.bidderId, auction.currentBid.amount);
    }
    // Kural 24 — hiç teklif verilmeden herkes pas geçti
    return resolveNoBidDistribution(state);
  }

  const next = { ...state, auction: { ...updatedAuction, activeBidderId: nextBidderId } };
  return { ok: true, state: next, event: { type: 'BIDDER_PASSED', passerId, nextBidderId } };
}

/**
 * Kural 19 — sıradaki uygun oyuncuyu (saat yönünde) bulur: aktif olmalı
 * (forfeited/dolu hariç), bu turda pas geçmemiş olmalı, mevcut en yüksek
 * teklif sahibi olmamalı. Kimse kalmazsa null döner.
 *
 * NOT (Kural 35): forfeited bir oyuncu currentBid.bidderId ise bu döngü onu
 * hiçbir zaman "sıradaki" olarak seçmez (aktif değildir) — ama bidini de
 * SİLMEZ. Böylece açık teklifleri forfeit sonrası korunmuş olur.
 */
function nextBidderAfter(state, fromId, auction) {
  const active   = activeIds(state);
  const startIdx = PLAYER_IDS.indexOf(fromId);
  for (let i = 1; i <= PLAYER_IDS.length; i++) {
    const candidate = PLAYER_IDS[(startIdx + i) % PLAYER_IDS.length];
    const isActive       = active.includes(candidate);
    const hasPassed       = auction.passedIds.includes(candidate);
    const isCurrentBidder = auction.currentBid?.bidderId === candidate;
    if (isActive && !hasPassed && !isCurrentBidder) return candidate;
  }
  return null;
}

function resolveAuctionWin(state, winnerId, price) {
  const item = currentQueueItem(state);
  const resultData  = { item, winnerId, price, auto: false, reason: 'bid_won' };
  const roundResult = makeRoundResult(resultData);
  const players = { ...state.players, [winnerId]: awardAnimal(state.players[winnerId], item, price, state.round) };
  const next = {
    ...state, players, status: STATUS.ROUND_RESULT, auction: null,
    roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { ok: true, state: next, event: { type: 'ITEM_WON_BY_BID', ...resultData } };
}

/** Kural 24 — teklifsiz herkes pas geçti. Pas geçenler de dahil, yeri olan herkes eligible. */
function resolveNoBidDistribution(state) {
  const item = currentQueueItem(state);
  const eligible = PLAYER_IDS.filter(
    (id) => playerStatus(state.players[id]) !== 'dolu' && !state.players[id].forfeited
  );
  const minCount = Math.min(...eligible.map((id) => state.players[id].animals.length));
  const eligibleAtMin = eligible.filter((id) => state.players[id].animals.length === minCount);
  const winnerId = firstMatching(state, (id) => eligibleAtMin.includes(id));

  const resultData  = { item, winnerId, price: 0, auto: true, reason: 'all_declined' };
  const roundResult = makeRoundResult(resultData);
  const players = { ...state.players, [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round) };
  const next = {
    ...state, players, status: STATUS.ROUND_RESULT, auction: null,
    roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { ok: true, state: next, event: { type: 'ITEM_DECLINED_BY_ALL', ...resultData } };
}

// ─── Tur İlerletme ────────────────────────────────────────

export function advanceRound(state) {
  const advanced = { ...state, round: state.round + 1, roundResult: null };
  return beginRound(advanced);
}

// ─── Forfeit Sırasında Serbest Seçim Otomatik Çözümü ───────

/**
 * Kural 37-B — KRİTİK kilitlenme düzeltmesi. 4P dokümanının özellikle
 * vurguladığı risk: FREE_CHOICE fazında TEK karar verici
 * (freeChoice.deciderId) forfeit olursa, CHOOSE_FREE_ITEM mesajını
 * gönderecek kimse kalmaz ve tur ASLA ilerlemez — oyun kilitlenir.
 *
 * Bu fonksiyon sunucu adına otomatik bir "hediye et" kararı üretir:
 * giftCandidateIds içinden (forfeit anında kendisi de forfeited olmuş
 * olabilecekler elenerek) envanteri en az olan (eşitlikte firstMatching
 * ile) oyuncuya öğe BEDAVA aktarılır. 4P'de giftCandidateIds 1-3 aday
 * içerebileceğinden bu seçim mantığı hepsine aynı şekilde uygulanır.
 *
 * giftCandidateIds'in tamamı da forfeited ise (teorik olarak olmamalı —
 * FREE_CHOICE'a girildiğinde en az bir aday parasız-yeri-var'dı — ama
 * savunma amaçlı) Bölüm E'deki genel otomatik dağıtım kuralına düşülür.
 * Uygun HİÇBİR oyuncu kalmazsa (herkes forfeited/dolu) öğe kimseye
 * verilmeden tur ROUND_RESULT'a düşürülür — bu durumda muhtemelen Kural 14
 * zaten devreye girip maçı bitirmiştir, GameEngine bu fonksiyonu hiç
 * çağırmaz (bkz. markForfeited'deki çağrı sırası).
 *
 * `markForfeited` tarafından, forfeited olan oyuncu tam da
 * `freeChoice.deciderId` ise otomatik çağrılır.
 */
export function resolveFreeChoiceOnForfeit(state) {
  const { freeChoice } = state;
  const item = currentQueueItem(state);

  const liveCandidates = freeChoice.giftCandidateIds.filter(
    (id) => !state.players[id].forfeited
  );

  if (liveCandidates.length > 0) {
    const minCount = Math.min(...liveCandidates.map((id) => state.players[id].animals.length));
    const eligibleAtMin = liveCandidates.filter((id) => state.players[id].animals.length === minCount);
    const winnerId = firstMatching(state, (id) => eligibleAtMin.includes(id));

    const resultData  = { item, winnerId, price: 0, auto: true, reason: 'free_choice_decider_forfeited' };
    const roundResult = makeRoundResult(resultData);
    const players = { ...state.players, [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round) };
    const next = {
      ...state, players, status: STATUS.ROUND_RESULT, freeChoice: null,
      roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
    };
    return { state: next, event: { type: 'FREE_ITEM_AUTO_GIFTED', ...resultData } };
  }

  // Savunma amaçlı düşüş — Bölüm E ile aynı mantık: yeri olan (dolu/forfeited
  // olmayan) TÜM oyunculardan envanteri en az olan(lar) arasından seç.
  const eligible = PLAYER_IDS.filter(
    (id) => playerStatus(state.players[id]) !== 'dolu' && !state.players[id].forfeited
  );

  if (eligible.length === 0) {
    // Gerçekten kimse kalmadı — öğeyi kimseye vermeden turu geç. Bu durumda
    // markForfeited zaten Kural 14'ü daha önce yakalamış olmalıydı; buraya
    // düşülmesi beklenmez, ama sonsuz kilitlenmektense öğeyi kaybetmek
    // tercih edilir.
    const next = { ...state, status: STATUS.ROUND_RESULT, freeChoice: null, roundResult: null };
    return { state: next, event: { type: 'FREE_CHOICE_SKIPPED_NO_ELIGIBLE' } };
  }

  const minCount = Math.min(...eligible.map((id) => state.players[id].animals.length));
  const eligibleAtMin = eligible.filter((id) => state.players[id].animals.length === minCount);
  const winnerId = firstMatching(state, (id) => eligibleAtMin.includes(id));

  const resultData  = { item, winnerId, price: 0, auto: true, reason: 'free_choice_decider_forfeited_fallback' };
  const roundResult = makeRoundResult(resultData);
  const players = { ...state.players, [winnerId]: awardAnimal(state.players[winnerId], item, 0, state.round) };
  const next = {
    ...state, players, status: STATUS.ROUND_RESULT, freeChoice: null,
    roundResult, log: [...state.log, makeLogLine(state.round, roundResult)],
  };
  return { state: next, event: { type: 'FREE_ITEM_AUTO_GIFTED', ...resultData } };
}
