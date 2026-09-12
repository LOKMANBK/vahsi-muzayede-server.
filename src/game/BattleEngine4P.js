// =========================================================
//  BattleEngine4P.js — 4 Kişilik Savaş Motoru
//
//  Kural referansları: 4_kisilik_mod_kurallari.md v2, Bölüm H-I.
//
//  NOT (tiebreak yöntemi — Kural 45 düzeltmesi): Bu dosya, BattleEngine3P.js'te
//  düzeltilen non-transitive comparator hatasını YAŞAMAZ; aynı doğru yöntem
//  (Fisher-Yates shuffle + rastgelelik içermeyen stabil sort zinciri) baştan
//  buraya uygulanmıştır. Ayrıntılı gerekçe için BattleEngine3P.js'teki
//  computeFinalRanking ve calculateBattleRound yorumlarına bakın — 4 oyuncuda
//  3'lü/4'lü tam eşitlik ihtimali arttığı için bu doğru yöntem burada daha da
//  önemlidir.
// =========================================================

import { STATUS, PLAYER_IDS, makeBattleMatch } from './GameState4P.js';

const POINT_TABLE = [3, 2, 1, 0]; // Kural 43 — 1.=3, 2.=2, 3.=1, 4.=0

// ─── Yardımcılar ──────────────────────────────────────────

/**
 * Adil rastgele karıştırma (Fisher-Yates). calculateBattleRound ve
 * computeFinalRanking'deki eşitlik durumları bu fonksiyonu kullanır.
 * Doğrudan Array.sort içine rastgele comparator koymak YANLIŞTIR (bkz.
 * dosya başı notu ve BattleEngine3P.js) — bu yüzden karıştırma adımı
 * sort'tan tamamen AYRIDIR.
 */
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
 * Kural 40-46: 4 oyuncunun aynı indeksteki hayvanlarını karşılaştırır, 3-2-1-0 puanlar.
 * @param {Record<string, object|null>} animalsByPlayer — { player1: entry|null, ... }
 */
export function calculateBattleRound(animalsByPlayer, rng = Math.random) {
  const powersByPlayer = {};
  PLAYER_IDS.forEach((id) => { powersByPlayer[id] = calculatePower(animalsByPlayer[id], rng); });

  // Kural 44 — float final değeriyle sırala. Kural 45 (düzeltilmiş) — tam
  // eşitlikte adil rastgelelik: ÖNCE shuffle ile taban sıra rastgeleleştirilir,
  // SONRA rastgelelik içermeyen stabil sort ile güce göre dizilir.
  const shuffled = shuffle(PLAYER_IDS, rng);
  const ranked = [...shuffled].sort(
    (a, b) => powersByPlayer[b].final - powersByPlayer[a].final
  );

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
    // Final sıralaması burada hesaplanıp state'e yazılır (bkz. AuctionEngine4P.js'teki
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
 * Final sıralama — Kural 47-51 (48: erken bitiş istisnası, 49: kısmi erken
 * bitiş normal sayılır).
 * 1) toplam savaş puanı  2) kalan bakiye  3) yazı tura
 *
 * ÖNEMLİ (tiebreak yöntemi): Doğrudan Array.sort içinde rastgele comparator
 * KULLANILMAZ (bkz. dosya başı notu). Önce Fisher-Yates ile adil bir taban
 * sıra kurulur, sonra her kritere göre AYRI AYRI stabil sort uygulanır —
 * JS Array.sort ES2019'dan beri stabil olmayı garanti eder, bu yüzden her
 * sort yalnızca kendi kriterinde eşit OLMAYANLARI yeniden sıralar ve eşit
 * olanların shuffle'dan gelen göreli sırasını korur.
 *
 * Kural 14 (erken bitiş) durumunda savaş hiç oynanmadığı için tüm puanlar
 * 0'dır ve bakiyeler de henüz hiç ayrışmamış olabilir. Bu yüzden
 * matchEndedEarly=true iken ayrılmamış/ayrılmış durumu EN SON (en güçlü
 * kriter olarak) uygulanır — normal bitişte (savaş oynandıysa) bu adım
 * atlanır ve ayrılmış oyuncular da diğerleriyle aynı kriterlerle yarışır
 * (Kural 48/49/51).
 */
export function computeFinalRanking(state, rng = Math.random) {
  let ids = shuffle(PLAYER_IDS, rng); // 1) adil rastgele taban — tüm tiebreak'lerin kaynağı

  ids = [...ids].sort((a, b) =>            // 2) stabil: kalan bakiye, yüksekten düşüğe
    state.players[b].balance - state.players[a].balance
  );

  ids = [...ids].sort((a, b) =>            // 3) stabil: toplam savaş puanı, yüksekten düşüğe
    (state.battle?.scores?.[b] ?? 0) - (state.battle?.scores?.[a] ?? 0)
  );

  if (state.matchEndedEarly) {
    ids = [...ids].sort((a, b) =>          // 4) stabil: ayrılmamış oyuncu her zaman önde (Kural 48)
      Number(state.players[a].forfeited) - Number(state.players[b].forfeited)
    );
  }

  return ids;
}
