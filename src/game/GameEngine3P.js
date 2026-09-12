// =========================================================
//  GameEngine3P.js — 3 Kişilik Merkezi Oyun Makinesi
//
//  2 kişilik GameEngine.js'e PARALEL bir sınıf. React/UI bağımlılığı yoktur.
// =========================================================

import { makeInitialState, STATUS, nonForfeitedIds } from './GameState3P.js';
import {
  buildQueue, beginRound, placeBid, pass, chooseFreeItem, advanceRound,
} from './AuctionEngine3P.js';
import {
  revealBattle, nextBattle, makeBattleState, computeFinalRanking,
} from './BattleEngine3P.js';

export class GameEngine3P {
  #state;
  #listeners = new Set();

  constructor(initialState = makeInitialState()) {
    this.#state = initialState;
  }

  // ── Okuma ──────────────────────────────────────────────

  getState() {
    const { _queue, ...publicState } = this.#state;
    return Object.freeze(publicState);
  }

  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // ── İç Yardımcılar ─────────────────────────────────────

  #commit(next, event) {
    this.#state = next;
    this.#listeners.forEach((fn) => fn(this.getState(), event));
  }
  #fail(error)    { return { ok: false, error }; }
  #succeed(event) { return { ok: true, event }; }

  // ── Action'lar ─────────────────────────────────────────

  startGame(playerNames = {}) {
    const fresh = { ...makeInitialState(undefined, playerNames), _queue: buildQueue() };
    const { state, event } = beginRound(fresh);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  placeBid(bidderId, amount) {
    const result = placeBid(this.#state, bidderId, amount);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  pass(passerId) {
    const result = pass(this.#state, passerId);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  /**
   * @param {'take'|'gift'} choice
   * @param {string|null} giftTargetId
   */
  chooseFreeItem(deciderId, choice, giftTargetId = null) {
    const result = chooseFreeItem(this.#state, deciderId, choice, giftTargetId);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  advanceRound() {
    if (this.#state.status !== STATUS.ROUND_RESULT) {
      return this.#fail('round_result statüsünde değiliz.');
    }
    const { state, event } = advanceRound(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  startBattle() {
    if (this.#state.status !== STATUS.COLLECTION) {
      return this.#fail('collection statüsünde değiliz.');
    }
    const next  = { ...this.#state, status: STATUS.BATTLE, battle: makeBattleState() };
    const event = { type: 'BATTLE_STARTED' };
    this.#commit(next, event);
    return this.#succeed(event);
  }

  revealBattle() {
    if (this.#state.status !== STATUS.BATTLE) return this.#fail('battle statüsünde değiliz.');
    if (this.#state.battle.revealed)          return this.#fail('Bu karşılaşma zaten açıldı.');
    const { state, event } = revealBattle(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  nextBattle() {
    if (this.#state.status !== STATUS.BATTLE)   return this.#fail('battle statüsünde değiliz.');
    if (!this.#state.battle.revealed)           return this.#fail('Önce karşılaşmayı açmalısın.');
    const { state, event } = nextBattle(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  /** Final sıralama (Kural 47-51). Yalnızca FINAL durumunda anlamlıdır. */
  getFinalRanking() {
    return computeFinalRanking(this.#state);
  }

  /**
   * RoomManager'ın reconnect-timeout akışından çağrılır (Bölüm G).
   * Oyuncuyu 'forfeited' işaretler; açık teklifleri İPTAL ETMEZ (Kural 23/35) —
   * yalnızca players[id].forfeited=true set eder, auction state'ine dokunmaz.
   * Ayrılmamış oyuncu sayısı 1'e düşerse (Kural 14) maçı hemen bitirir.
   */
  markForfeited(playerId) {
    if (!this.#state.players[playerId] || this.#state.players[playerId].forfeited) {
      return this.#fail('Oyuncu zaten ayrılmış veya bulunamadı.');
    }

    const players = {
      ...this.#state.players,
      [playerId]: { ...this.#state.players[playerId], forfeited: true },
    };
    let next = { ...this.#state, players };

    const remaining = nonForfeitedIds(next);
    let matchEndedEarly = false;
    if (remaining.length <= 1 && next.status !== STATUS.FINAL) {
      next = { ...next, status: STATUS.FINAL, matchEndedEarly: true };
      matchEndedEarly = true;
    }

    const event = { type: 'PLAYER_FORFEITED', playerId, matchEndedEarly, remaining };
    this.#commit(next, event);
    return this.#succeed(event);
  }

  // ── Serialization ──────────────────────────────────────

  serialize()                { return JSON.stringify(this.#state); }
  static deserialize(json)   { return new GameEngine3P(JSON.parse(json)); }
  static fromState(state)    { return new GameEngine3P(state); }
}
