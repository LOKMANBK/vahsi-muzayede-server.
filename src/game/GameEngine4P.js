// =========================================================
//  GameEngine4P.js — 4 Kişilik Merkezi Oyun Makinesi
//
//  3 kişilik GameEngine3P.js'e PARALEL bir sınıf. React/UI bağımlılığı yoktur.
// =========================================================

import { makeInitialState, STATUS, nonForfeitedIds } from './GameState4P.js';
import {
  buildQueue, beginRound, placeBid, pass, chooseFreeItem, advanceRound,
  resolveFreeChoiceOnForfeit,
} from './AuctionEngine4P.js';
import {
  revealBattle, nextBattle, makeBattleState, computeFinalRanking,
} from './BattleEngine4P.js';

export class GameEngine4P {
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
   *
   * KRİTİK: Kural 33 ve 37-B, 4P'de "zorunlu" olarak işaretlenmiş iki
   * kilitlenme riskiydi:
   *  - Kural 33 (hazır-olma sayımı): forfeited oyuncular RoomManager'daki
   *    ready-map'te otomatik hazır sayılmalı — bu düzeltme RoomManager.js
   *    tarafında (#makeReadyMap ve #forfeit) yapılır, burada değil.
   *  - Kural 37-B (bu metotta): oyun FREE_CHOICE fazındayken TAM DA karar
   *    verici (freeChoice.deciderId) forfeit olursa, CHOOSE_FREE_ITEM
   *    mesajını gönderecek kimse kalmaz ve tur SONSUZA KADAR ilerlemez.
   *    Bu durum burada resolveFreeChoiceOnForfeit ile otomatik çözülür.
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
    let freeChoiceAutoResolved = null;

    if (remaining.length <= 1 && next.status !== STATUS.FINAL) {
      next = { ...next, status: STATUS.FINAL, matchEndedEarly: true };
      next = { ...next, finalRanking: computeFinalRanking(next) };
      matchEndedEarly = true;
    } else if (next.status === STATUS.FREE_CHOICE && next.freeChoice?.deciderId === playerId) {
      // Kural 37-B
      const resolved = resolveFreeChoiceOnForfeit(next);
      next = resolved.state;
      freeChoiceAutoResolved = resolved.event;
    }

    const event = {
      type: 'PLAYER_FORFEITED', playerId, matchEndedEarly, remaining,
      finalRanking: next.finalRanking ?? null,
      freeChoiceAutoResolved, // RoomManager buna bakıp ROUND_RESULT için auto-timer kurar
    };
    this.#commit(next, event);
    return this.#succeed(event);
  }

  // ── Serialization ──────────────────────────────────────

  serialize()                { return JSON.stringify(this.#state); }
  static deserialize(json)   { return new GameEngine4P(JSON.parse(json)); }
  static fromState(state)    { return new GameEngine4P(state); }
}
