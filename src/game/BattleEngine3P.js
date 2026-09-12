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

  // Kural 44 — float final değeriyle sırala. Kural 45 (düzeltilmiş) — tam
  // eşitlikte adil rastgelelik: ÖNCE shuffle ile taban sıra rastgeleleştirilir,
  // SONRA rastgelelik içermeyen stabil sort ile güce göre dizilir. Doğrudan
  // `rng()<0.5?-1:1` gibi bir comparator kullanmak non-transitive olduğu için
  // sort algoritmasını yanıltıp yanlı (biased) sonuçlar üretebilir — bkz.
  // computeFinalRanking'deki aynı düzeltmenin gerekçe notu.
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
 * Adil rastgele karıştırma (Fisher-Yates). computeFinalRanking ve
 * calculateBattleRound'daki eşitlik durumları bu fonksiyonu kullanır —
 * bkz. aşağıdaki uyarı, neden Array.sort içine doğrudan rastgele
 * comparator konulmaması gerektiğini açıklıyor.
 */
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Final sıralama — Kural 47-51 (4P dokümanı: Kural 45'in düzeltmesi burada
 * da uygulanmıştır).
 * 1) toplam savaş puanı  2) kalan bakiye  3) yazı tura
 *
 * ÖNEMLİ (düzeltme — non-transitive comparator hatası): Bu fonksiyon
 * eskiden TEK bir sort çağrısı içinde, eşitlik durumunda doğrudan
 * `rng() < 0.5 ? -1 : 1` döndürüyordu. Bu YANLIŞTIR: sort algoritmaları
 * comparator'ın TUTARLI (transitive) olmasını varsayar — yani a<b ve b<c
 * ise a<c olmalıdır. Rastgele bir comparator bu varsayımı bozar ve motor
 * implementasyonuna göre (V8'in TimSort'u dahil) YANLI (biased) sonuçlar
 * üretebilir; bazı elemanlar istatistiksel olarak diğerlerinden daha sık
 * öne/arkaya düşer. 3 oyuncuda etkisi küçük kalabiliyordu, 4 oyuncuda
 * (özellikle erken bitişte 3'lü tam eşitlik ihtimali arttığı için) daha
 * belirgin hale gelir.
 *
 * Doğru yöntem: ÖNCE Fisher-Yates ile adil bir rastgele taban sıra kur,
 * SONRA bu taban üzerinde her kritere göre AYRI AYRI, rastgelelik
 * içermeyen STABİL sort'lar uygula (JS Array.sort ES2019'dan beri stabil
 * olmayı garanti eder). Her stabil sort yalnızca kendi kriterinde eşit
 * OLMAYANLARI yeniden sıralar; kriterde eşit olanların şuffle'dan gelen
 * göreli sırası korunur — bu da eşitlik durumunda adil bir tiebreak'e
 * eşdeğerdir.
 *
 * Kural 14 (A3 — erken bitiş) durumunda savaş hiç oynanmadığı için tüm
 * puanlar 0'dır ve bakiyeler de henüz hiç ayrışmamış olabilir (oyun daha
 * yeni başlamışsa herkes başlangıç bakiyesindedir). Bu durumda normal
 * puan→bakiye→yazıtura zinciri rastgele bir sonuca düşebilir — ama Kural 14
 * açıkça "kalan oyuncu galip ilan edilir" diyor, tesadüfe bırakılamaz.
 * Bu yüzden matchEndedEarly=true iken ayrılmamış/ayrılmış durumu EN SON
 * (en güçlü kriter olarak) uygulanır; normal bitişte (savaş oynandıysa)
 * bu adım atlanır ve ayrılmış oyuncular da diğerleriyle aynı kriterlerle
 * yarışır (Kural 51).
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
    ids = [...ids].sort((a, b) =>          // 4) stabil: ayrılmamış oyuncu her zaman önde
      Number(state.players[a].forfeited) - Number(state.players[b].forfeited)
    );
  }

  return ids;
}
