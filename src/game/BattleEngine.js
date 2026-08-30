// =========================================================
//  BATTLE ENGINE
//  Yeni kanonik model üzerinde çalışır.
//  scores bir obje: { player1: n, player2: n }
// =========================================================

import { STATUS, opponentOf, makeBattleMatch } from './GameState.js';

// ─── Güç Hesabı ───────────────────────────────────────────

/**
 * Bir hayvan grubunun savaş gücünü hesaplar.
 * `rng` parametresi test ve sunucu seed'i için override edilebilir.
 *
 * @param  {{ power: {basePower,attack,defense,speed}, quantity }} animalEntry
 * @param  {() => number} [rng]
 * @returns {{ basePart, flatPart, base, factorPct, final }}
 */
export function calculatePower(animalEntry, rng = Math.random) {
  const { power, quantity } = animalEntry;
  const basePart  = power.basePower * quantity;
  const flatPart  = power.attack + power.defense + power.speed;
  const base      = basePart + flatPart;
  const variance  = 0.10 + rng() * 0.05;
  const sign      = rng() < 0.5 ? -1 : 1;
  const factor    = 1 + sign * variance;
  const final     = Math.max(1, Math.round(base * factor));
  return { basePart, flatPart, base, factorPct: Math.round(sign * variance * 100), final };
}

/**
 * İki hayvan grubunu karşılaştırır. State bilmez — saf hesap.
 *
 * @param  animalEntry1  — player1'in hayvanı
 * @param  animalEntry2  — player2'nin hayvanı
 * @param  {() => number} [rng]
 * @returns {{ r1, r2, winnerId: 'player1'|'player2' }}
 */
export function calculateBattle(animalEntry1, animalEntry2, rng = Math.random) {
  const r1 = calculatePower(animalEntry1, rng);
  const r2 = calculatePower(animalEntry2, rng);
  const winnerId = r1.final > r2.final ? 'player1'
                 : r2.final > r1.final ? 'player2'
                 : rng() < 0.5 ? 'player1' : 'player2';
  return { r1, r2, winnerId };
}

// ─── State Geçişleri ──────────────────────────────────────

/**
 * Mevcut karşılaşmayı açar, gücü hesaplar, state günceller.
 *
 * @param   {GameState} state
 * @param   {() => number} [rng]
 * @returns {{ state: GameState, event: GameEvent }}
 */
export function revealBattle(state, rng = Math.random) {
  const { matchIndex } = state.battle;
  const p1Animal = state.players.player1.animals[matchIndex];
  const p2Animal = state.players.player2.animals[matchIndex];

  const { r1, r2, winnerId } = calculateBattle(p1Animal, p2Animal, rng);

  const scores = {
    player1: state.battle.scores.player1 + (winnerId === 'player1' ? 1 : 0),
    player2: state.battle.scores.player2 + (winnerId === 'player2' ? 1 : 0),
  };

  const match = makeBattleMatch({
    matchIndex,
    p1Animal,
    p2Animal,
    r1,
    r2,
    winnerId,
  });

  const next = {
    ...state,
    battle: {
      ...state.battle,
      revealed:     true,
      currentMatch: match,
      matches:      [...state.battle.matches, match],
      scores,
    },
  };
  return {
    state: next,
    event: { type: 'BATTLE_REVEALED', matchIndex, r1, r2, winnerId, scores },
  };
}

/**
 * Bir sonraki karşılaşmaya ya da final fazına geçer.
 *
 * @param   {GameState} state
 * @returns {{ state: GameState, event: GameEvent }}
 */
export function nextBattle(state) {
  const nextIndex = state.battle.matchIndex + 1;

  if (nextIndex >= 5) {
    const next = { ...state, status: STATUS.FINAL };
    return {
      state: next,
      event: { type: 'BATTLE_SERIES_ENDED', scores: state.battle.scores },
    };
  }

  const next = {
    ...state,
    battle: {
      ...state.battle,
      matchIndex:   nextIndex,
      revealed:     false,
      currentMatch: null,
    },
  };
  return {
    state: next,
    event: { type: 'NEXT_BATTLE_STARTED', matchIndex: nextIndex },
  };
}

/**
 * Savaş serisinin başlangıç alt-state'i.
 */
export function makeBattleState() {
  return {
    matchIndex:   0,
    revealed:     false,
    currentMatch: null,
    matches:      [],
    scores: { player1: 0, player2: 0 },
  };
}
