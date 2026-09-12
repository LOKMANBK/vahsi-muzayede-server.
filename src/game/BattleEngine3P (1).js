// =========================================================
//  BattleEngine3P.js — 3 Kişilik Savaş Motoru
//
//  Kural referansları: 3_kisilik_mod_kurallari.md v4, Bölüm H-I.
// =========================================================

import { STATUS, PLAYER_IDS, makeBattleMatch } from './GameState3P.js';

const POINT_TABLE = [3, 2, 0]; // Kural 43 — 1.=3, 2.=2, 3.=0

// ─── Güç Hesabı ───────────────────────────────────────────

/**
 * @param  {{power:{basePower,attack,defense,speed}, quantity}|null} animalEntry
 * @param  {() => number} [rng]
 */
export function calculatePower(animalEntry, rng = Math.random) {
  if (!animalEntry) {
    // Kural 42 — eksik slot / ayrılmış oyuncu → 0 güç
    return { basePart: 0, flatPart: 0, base: 0, factorPct: 0, final: 0 };
  }
  const { power, quantity } = animalEntry;
  const basePart = power.basePower * quantity;
  const flatPart = power.attack + power.defense + power.speed;
  const base     = basePart + flatPart;
  const variance = 0.10 + rng() * 0.05;
  const sign     = rng() < 0.5 ? -1 : 1;
  const factor   = 1 + sign * variance;
  // Kural 44 — YUVARLANMAMIŞ (float) değer saklanır. UI'da Math.round ile gösterilir,
  // ama karşılaştırma/puanlama hep bu ham değerle yapılır.
  const finalRaw = Math.max(1, base * factor);
  return { basePart, flatPart, base, factorPct: Math.round(sign * variance * 100), final: finalRaw };
}

/**
 * Kural 40-46: 3 oyuncunun aynı indeksteki hayvanlarını karşılaştırır, 3-2-0 puanlar.
 * @param {Record<string, object|null>} animalsByPlayer — { player1: entry|null, ... }
 */
export function calculateBattleRound(animalsByPlayer, rng = Math.random) {
  const powersByPlayer = {};
  PLAYER_IDS.forEach((id) => { powersByPlayer[id] = calculatePower(animalsByPlayer[id], rng); });

  // Kural 44 — float final değeriyle sırala. Kural 45 — tam eşitlikte rastgele.
  const ranked = [...PLAYER_IDS].sort((a, b) => {
    const diff = powersByPlayer[b].final - powersByPlayer[a].final;
    if (diff !== 0) return diff;
    return rng() < 0.5 ? -1 : 1;
  });

  const pointsByPlayer = {};
  ranked.forEach((id, idx) => { pointsByPlayer[id] = POINT_TABLE[idx] ?? 0; });

  return { powersByPlayer, pointsByPlayer, rankedIds: ranked };
}

// ─── State Geçişleri ──────────────────────────────────────

export function revealBattle(state, rng = Math.random) {
  const { matchIndex } = state.battle;
  const animalsByPlayer = {};
  PLAYER_IDS.forEach((id) => { animalsByPlayer[id] = state.players[id].animals[matchIndex] ?? null; });

  const { powersByPlayer, pointsByPlayer, rankedIds } = calculateBattleRound(animalsByPlayer, rng);

  const scores = { ...state.battle.scores };
  PLAYER_IDS.forEach((id) => { scores[id] += pointsByPlayer[id]; });

  const match = makeBattleMatch({ matchIndex, animalsByPlayer, powersByPlayer, pointsByPlayer, rankedIds });

  const next = {
    ...state,
    battle: {
      ...state.battle, revealed: true, currentMatch: match,
      matches: [...state.battle.matches, match], scores,
    },
  };
  return { state: next, event: { type: 'BATTLE_REVEALED', matchIndex, powersByPlayer, pointsByPlayer, rankedIds, scores } };
}

export function nextBattle(state) {
  const nextIndex = state.battle.matchIndex + 1;

  if (nextIndex >= 5) {
    const next = { ...state, status: STATUS.FINAL };
    // Final sıralaması burada hesaplanıp state'e yazılır (bkz. AuctionEngine3P.js'teki
    // aynı gerekçeli not — client tiebreak'i güvenilir şekilde tekrar hesaplayamaz).
    const finalRanking = computeFinalRanking(next);
    const withRanking = { ...next, finalRanking };
    return { state: withRanking, event: { type: 'BATTLE_SERIES_ENDED', scores: state.battle.scores, finalRanking } };
  }

  const next = {
    ...state,
    battle: { ...state.battle, matchIndex: nextIndex, revealed: false, currentMatch: null },
  };
  return { state: next, event: { type: 'NEXT_BATTLE_STARTED', matchIndex: nextIndex } };
}

export function makeBattleState() {
  const scores = {};
  PLAYER_IDS.forEach((id) => { scores[id] = 0; });
  return { matchIndex: 0, revealed: false, currentMatch: null, matches: [], scores };
}

/**
 * Final sıralama — Kural 47-51.
 * 1) toplam savaş puanı  2) kalan bakiye  3) yazı tura
 *
 * Kural 14 (A3 — erken bitiş) durumunda savaş hiç oynanmadığı için tüm
 * puanlar 0'dır ve bakiyeler de henüz hiç ayrışmamış olabilir (oyun daha
 * yeni başlamışsa herkes başlangıç bakiyesindedir). Bu durumda normal
 * puan→bakiye→yazıtura zinciri rastgele bir sonuca düşebilir — ama Kural 14
 * açıkça "kalan oyuncu galip ilan edilir" diyor, tesadüfe bırakılamaz.
 * Bu yüzden matchEndedEarly=true iken ayrılmamış/ayrılmış durumu EN ÖNCE
 * kontrol edilir; normal bitişte (savaş oynandıysa) bu kontrol atlanır ve
 * ayrılmış oyuncular da diğerleriyle aynı kriterlerle yarışır (Kural 51).
 */
export function computeFinalRanking(state, rng = Math.random) {
  return [...PLAYER_IDS].sort((a, b) => {
    if (state.matchEndedEarly) {
      const forfA = state.players[a].forfeited;
      const forfB = state.players[b].forfeited;
      if (forfA !== forfB) return forfA ? 1 : -1; // ayrılmamış oyuncu öne geçer
    }

    const scoreA = state.battle?.scores?.[a] ?? 0;
    const scoreB = state.battle?.scores?.[b] ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const balA = state.players[a].balance;
    const balB = state.players[b].balance;
    if (balA !== balB) return balB - balA;

    return rng() < 0.5 ? -1 : 1;
  });
}
