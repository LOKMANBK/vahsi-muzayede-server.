// =========================================================
//  GAME ENGINE — Merkezi Oyun Makinesi
//  Kanonik modelin üstünde çalışır.
//  React bağımlılığı yoktur.
// =========================================================

import { makeInitialState, STATUS } from './GameState.js';
import { buildQueue, beginRound, placeBid, pass, chooseFreeItem, advanceRound } from './AuctionEngine.js';
import { revealBattle, nextBattle, makeBattleState } from './BattleEngine.js';

export class GameEngine {
  #state;
  #listeners = new Set();

  constructor(initialState = makeInitialState()) {
    this.#state = initialState;
  }

  // ── Okuma ──────────────────────────────────────────────

  /** Anlık state snapshot'ı (freeze edilmiş). _queue istemciye gönderilmez. */
  getState() {
    const { _queue, ...publicState } = this.#state;
    return Object.freeze(publicState);
  }

  /** Engine-internal tam state — sadece serialize/deserialize için. */
  #getFullState() {
    return this.#state;
  }

  /**
   * State değişimlerine abone ol.
   * @param {(state, event) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // ── İç Yardımcılar ─────────────────────────────────────

  #commit(next, event) {
    this.#state = next;
    this.#listeners.forEach((fn) => fn(this.getState(), event));
  }

  #fail(error)   { return { ok: false, error }; }
  #succeed(event){ return { ok: true, event }; }

  // ── Action'lar ─────────────────────────────────────────

  /** Yeni oyun başlatır. */
  startGame(playerNames = {}) {
    const fresh = {
      ...makeInitialState(undefined, playerNames),
      _queue: buildQueue(),
    };
    const { state, event } = beginRound(fresh);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  /**
   * Teklif verme.
   * @param {'player1'|'player2'} bidderId
   * @param {number} amount
   */
  placeBid(bidderId, amount) {
    const result = placeBid(this.#state, bidderId, amount);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  /**
   * Pas geçme.
   * @param {'player1'|'player2'} passerId
   */
  pass(passerId) {
    const result = pass(this.#state, passerId);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  /**
   * Rakip parasız kaldığında teklif verebilen oyuncunun kararı.
   * @param {'player1'|'player2'} deciderId
   * @param {'take'|'pass'} choice
   */
  chooseFreeItem(deciderId, choice) {
    const result = chooseFreeItem(this.#state, deciderId, choice);
    if (!result.ok) return this.#fail(result.error);
    this.#commit(result.state, result.event);
    return this.#succeed(result.event);
  }

  /** Tur sonucunu onaylayıp sonraki tura geçer. */
  advanceRound() {
    if (this.#state.status !== STATUS.ROUND_RESULT) {
      return this.#fail('round_result statüsünde değiliz.');
    }
    const { state, event } = advanceRound(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  /** Savaş serisini başlatır. */
  startBattle() {
    if (this.#state.status !== STATUS.COLLECTION) {
      return this.#fail('collection statüsünde değiliz.');
    }
    const next  = { ...this.#state, status: STATUS.BATTLE, battle: makeBattleState() };
    const event = { type: 'BATTLE_STARTED' };
    this.#commit(next, event);
    return this.#succeed(event);
  }

  /** Mevcut karşılaşmayı açar. */
  revealBattle() {
    if (this.#state.status !== STATUS.BATTLE) {
      return this.#fail('battle statüsünde değiliz.');
    }
    if (this.#state.battle.revealed) {
      return this.#fail('Bu karşılaşma zaten açıldı.');
    }
    const { state, event } = revealBattle(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  /** Sonraki karşılaşmaya ya da final'e geçer. */
  nextBattle() {
    if (this.#state.status !== STATUS.BATTLE) {
      return this.#fail('battle statüsünde değiliz.');
    }
    if (!this.#state.battle.revealed) {
      return this.#fail('Önce karşılaşmayı açmalısın.');
    }
    const { state, event } = nextBattle(this.#state);
    this.#commit(state, event);
    return this.#succeed(event);
  }

  // ── Serialization ──────────────────────────────────────

  /** _queue dahil tam state'i serialize eder (Redis için). */
  serialize()                   { return JSON.stringify(this.#state); }
  static deserialize(json)      { return new GameEngine(JSON.parse(json)); }
  static fromState(state)       { return new GameEngine(state); }
}
