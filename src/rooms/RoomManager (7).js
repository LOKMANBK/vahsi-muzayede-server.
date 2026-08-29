// =========================================================
//  RoomManager
// =========================================================

import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import { saveGameState, loadGameState } from '../utils/redis.js';
import { logger }                    from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;   // 20 saniye — istekte belirtilen

// "Otomatik" faz geçişleri için sunucu-taraflı süreler.
// Bu geçişler ARTIK hiçbir istemciye bağımlı değil — istemci
// bağlantısı kopsa, sekme arka plana atılsa, hatta iki taraf da
// tamamen kapatılsa bile sunucu bu geçişleri kendi başına yapar.
const AUTO_DELAYS = Object.freeze({
  [STATUS.ROUND_RESULT]: 3_000,
  [STATUS.COLLECTION]:   10_000,
  [STATUS.BATTLE]:       5_000,   // reveal öncesi — "savaşıyor…" bekleme
});

// Karşılaşma açıldıktan (revealed=true) sonra bir sonrakine otomatik geçiş süresi.
const BATTLE_NEXT_DELAY_MS = 4_000;

export class RoomManager {
  #rooms = new Map();
  #reconnectMs;
  #autoTimers = new Map();   // gameId -> Timeout

  constructor(reconnectMs = DEFAULT_RECONNECT_MS) {
    this.#reconnectMs = reconnectMs;
  }

  async connect(ws, opts = {}) {
    let room, playerId;

    if (opts.gameId) {
      room     = await this.#getOrRestoreRoom(opts.gameId);
      playerId = this.#assignSlot(room, ws, opts.playerName);
    } else {
      room     = this.#findFreshWaitingRoom() ?? this.#createRoom();
      playerId = this.#assignSlot(room, ws, opts.playerName);
    }

    ws._gameId   = room.gameId;
    ws._playerId = playerId;

    logger.info('Oyuncu baglandi', { gameId: room.gameId, playerId });
    this.#sendTo(ws, {
      type: 'CONNECTED', gameId: room.gameId, playerId,
      state: room.engine.getState(),
    });

    if (this.#bothConnected(room) && room.status === 'waiting') {
      room.status = 'playing';
      const names = {
        player1: room.slots.player1.name ?? 'Oyuncu 1',
        player2: room.slots.player2.name ?? 'Oyuncu 2',
      };
      const result = room.engine.startGame(names);
      await this.#broadcast(room, room.engine.getState(), result.event);
      await saveGameState(room.gameId, room.engine.getState());
      logger.info('Oyun basladi', { gameId: room.gameId });
      this.#scheduleAuto(room);
    }

    return { gameId: room.gameId, playerId };
  }

  disconnect(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    if (!gameId || !playerId) return;
    const room = this.#rooms.get(gameId);
    if (!room) return;
    const slot = room.slots[playerId];
    if (!slot) return;

    slot.ws     = null;
    slot.awayAt = Date.now();
    logger.info('Oyuncu ayrildi', { gameId, playerId });

    // Waiting modda → odayı sil
    if (room.status === 'waiting') {
      this.#clearAutoTimer(gameId);
      this.#rooms.delete(gameId);
      logger.info('Waiting oda kaldirildi', { gameId });
      return;
    }

    // Playing modda → rakibe bildir, reconnect penceresi başlat
    if (room.status === 'playing') {
      this.#notifyOther(room, playerId, {
        type: 'OPPONENT_DISCONNECTED',
        playerId,
        reconnectMs: this.#reconnectMs,
      });

      slot.reconnectTimer = setTimeout(async () => {
        logger.warn('Reconnect suresi doldu', { gameId, playerId });
        // Kopan oyuncu kaybeder, kalan oyuncu kazanır
        await this.#forfeit(room, playerId);
      }, this.#reconnectMs);
    }
  }

  async handleAction(ws, action) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);

    if (!room) {
      this.#sendTo(ws, { type: 'ERROR', error: 'Oda bulunamadi.' }); return;
    }
    if (room.status !== 'playing') {
      this.#sendTo(ws, { type: 'ERROR', error: 'Oyun aktif degil.' }); return;
    }

    const authError = this.#authorize(action, playerId);
    if (authError) {
      logger.warn('Yetkisiz action', { gameId, playerId, type: action.type });
      this.#sendTo(ws, { type: 'ACTION_REJECTED', error: authError }); return;
    }

    const result = applyAction(room.engine, action);
    if (!result.ok) {
      this.#sendTo(ws, { type: 'ACTION_REJECTED', error: result.error }); return;
    }

    const newState = room.engine.getState();
    this.#syncCollectionReady(room, newState);
    await this.#broadcast(room, newState, result.event);
    await saveGameState(gameId, newState);

    if (newState.status === STATUS.FINAL) {
      this.#clearAutoTimer(gameId);
      await this.#closeRoom(room, 'finished');
      return;
    }

    // İstemciden gelen her action, o an yürürlükte olan otomatik
    // zamanlayıcıyı geçersiz kılabilir (örn. oyuncu erken pas geçti,
    // ya da zaten sunucu otomatik ilerletmişti). Güncel duruma göre
    // zamanlayıcıyı her seferinde yeniden kur.
    this.#scheduleAuto(room);
  }

  /**
   * Bir oyuncu "Hazırım" dediğinde çağrılır (collection fazı).
   * Sunucu her iki oyuncunun da hazır durumunu tutar ve rakibe yayınlar —
   * böylece her istemci kendi hazır durumunu değil, gerçek/ortak durumu
   * görür. İkisi de hazır olduğunda oyun 10sn'lik zamanlayıcıyı beklemeden
   * hemen savaşa geçer.
   */
  async handleReady(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);
    if (!room || room.status !== 'playing' || !playerId) return;

    const state = room.engine.getState();
    if (state.status !== STATUS.COLLECTION) return;

    room.collectionReady[playerId] = true;
    this.#broadcastReady(room);

    const { player1, player2 } = room.collectionReady;
    if (!(player1 && player2)) return;

    this.#clearAutoTimer(gameId);
    const result = applyAction(room.engine, { type: ACTION_TYPES.START_BATTLE, payload: {} });
    if (!result.ok) return; // durum bu arada değişmiş olabilir — zararsız

    const newState = room.engine.getState();
    logger.info('Iki oyuncu da hazir — savas basliyor', { gameId });
    await this.#broadcast(room, newState, result.event);
    await saveGameState(gameId, newState);

    if (newState.status === STATUS.FINAL) {
      await this.#closeRoom(room, 'finished');
      return;
    }
    this.#scheduleAuto(room);
  }

  /** collection fazına yeni girildiyse hazır durumlarını sıfırlar. */
  #syncCollectionReady(room, newState) {
    if (newState.status === STATUS.COLLECTION) {
      room.collectionReady = { player1: false, player2: false };
    }
  }

  #broadcastReady(room) {
    const msg = JSON.stringify({ type: 'READY_UPDATE', ready: { ...room.collectionReady } });
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) slot.ws.send(msg);
    }
  }

  // ── Otomatik faz ilerletme (sunucu-taraflı, istemciden bağımsız) ──

  /**
   * Odanın mevcut durumuna göre bir sonraki otomatik geçişi zamanlar.
   * Önceki zamanlayıcı varsa temizlenir. STATUS'a karşılık gelen bir
   * AUTO_DELAYS girdisi yoksa (ör. AUCTION, WAITING, FINAL) hiçbir şey
   * zamanlanmaz — o fazlar zaten oyuncu aksiyonuyla ilerler.
   */
  #scheduleAuto(room) {
    this.#clearAutoTimer(room.gameId);
    if (room.status !== 'playing') return;

    const state = room.engine.getState();

    let delay, actionType;
    if (state.status === STATUS.BATTLE && state.battle?.revealed) {
      // Karşılaşma açıldı — sonuç görüldükten sonra sunucu kendi başına
      // bir sonraki karşılaşmaya (ya da final'e) geçer. Oyuncu aksiyonu
      // gerekmez.
      delay      = BATTLE_NEXT_DELAY_MS;
      actionType = ACTION_TYPES.NEXT_BATTLE;
    } else {
      delay = AUTO_DELAYS[state.status];
      actionType = {
        [STATUS.ROUND_RESULT]: ACTION_TYPES.ADVANCE_ROUND,
        [STATUS.COLLECTION]:   ACTION_TYPES.START_BATTLE,
        [STATUS.BATTLE]:       ACTION_TYPES.REVEAL_BATTLE,
      }[state.status];
    }
    if (!delay) return;

    const timer = setTimeout(() => {
      this.#autoAdvance(room, actionType).catch((err) => {
        logger.error('Otomatik ilerletme hatasi', { gameId: room.gameId, err: err.message });
      });
    }, delay);

    this.#autoTimers.set(room.gameId, timer);
  }

  #clearAutoTimer(gameId) {
    const timer = this.#autoTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.#autoTimers.delete(gameId);
    }
  }

  async #autoAdvance(room, actionType) {
    this.#autoTimers.delete(room.gameId);
    if (room.status !== 'playing') return;

    const result = applyAction(room.engine, { type: actionType, payload: {} });
    if (!result.ok) {
      // Durum bu arada değişmiş olabilir (ör. bir oyuncu tam bu sırada
      // aksiyon gönderdi) — zararsız, sessizce yut.
      logger.debug('Otomatik aksiyon uygulanamadi', { gameId: room.gameId, actionType, error: result.error });
      return;
    }

    const newState = room.engine.getState();
    this.#syncCollectionReady(room, newState);
    logger.info('Otomatik faz gecisi', { gameId: room.gameId, actionType, newStatus: newState.status });
    await this.#broadcast(room, newState, result.event);
    await saveGameState(room.gameId, newState);

    if (newState.status === STATUS.FINAL) {
      this.#clearAutoTimer(room.gameId);
      await this.#closeRoom(room, 'finished');
      return;
    }

    this.#scheduleAuto(room);
  }

  // ── Forfeit: kopan oyuncu kaybeder ────────────────────────
  async #forfeit(room, disconnectedPlayerId) {
    const winnerId = disconnectedPlayerId === 'player1' ? 'player2' : 'player1';
    logger.info('Forfeit', { gameId: room.gameId, loser: disconnectedPlayerId, winner: winnerId });

    // Kazanana GAME_OVER_FORFEIT gönder
    const winnerSlot = room.slots[winnerId];
    const forfeitMsg = JSON.stringify({
      type: 'GAME_OVER_FORFEIT',
      winnerId,
      loserId: disconnectedPlayerId,
      reason: 'opponent_disconnected',
    });

    if (winnerSlot?.ws?.readyState === 1) {
      winnerSlot.ws.send(forfeitMsg);
    }

    // Kopan oyuncuya da gönder (eğer hâlâ bağlantısı açık kaldıysa)
    const loserSlot = room.slots[disconnectedPlayerId];
    if (loserSlot?.ws?.readyState === 1) {
      loserSlot.ws.send(forfeitMsg);
    }

    await this.#closeRoom(room, 'forfeit');
  }

  // ── Özel yardımcılar ─────────────────────────────────────

  #createRoom() {
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room   = {
      gameId,
      status: 'waiting',
      engine: new GameEngine(),
      collectionReady: { player1: false, player2: false },
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null },
      },
    };
    this.#rooms.set(gameId, room);
    logger.info('Oda olusturuldu', { gameId });
    return room;
  }

  async #getOrRestoreRoom(gameId) {
    if (this.#rooms.has(gameId)) return this.#rooms.get(gameId);
    const saved = await loadGameState(gameId);
    if (!saved) throw new Error('Oda bulunamadi: ' + gameId);
    const room = {
      gameId,
      status: saved.status === STATUS.FINAL ? 'finished' : 'playing',
      engine: GameEngine.fromState(saved),
      collectionReady: { player1: false, player2: false },
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null },
      },
    };
    this.#rooms.set(gameId, room);
    return room;
  }

  #findFreshWaitingRoom() {
    for (const room of this.#rooms.values()) {
      if (room.status !== 'waiting') continue;
      const hasVirginSlot = Object.values(room.slots).some(s => !s.ws && s.name === null);
      if (hasVirginSlot) return room;
    }
    return null;
  }

  #assignSlot(room, ws, name) {
    // Reconnect: aynı isimle geri dönen away slot
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (slot.name === name && slot.ws === null && slot.awayAt !== null) {
        clearTimeout(slot.reconnectTimer);
        slot.ws     = ws;
        slot.awayAt = null;
        logger.info('Reconnect', { gameId: room.gameId, playerId: pid });
        return pid;
      }
    }
    // Boş slot
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (!slot.ws && slot.name === null) {
        slot.ws   = ws;
        slot.name = name ?? pid;
        return pid;
      }
    }
    throw new Error('Oda dolu.');
  }

  #bothConnected(room) {
    return room.slots.player1.ws !== null && room.slots.player2.ws !== null;
  }

  #authorize(action, playerId) {
    const { type, payload } = action;
    const checks = {
      [ACTION_TYPES.PLACE_BID]:        (p) => p.bidderId  === playerId,
      [ACTION_TYPES.PASS]:             (p) => p.passerId  === playerId,
      [ACTION_TYPES.CHOOSE_FREE_ITEM]: (p) => p.deciderId === playerId,
    };
    const check = checks[type];
    if (check && !check(payload)) return 'Bu action sana ait degil. Senin: ' + playerId;
    return null;
  }

  async #broadcast(room, state, event) {
    const msg = JSON.stringify({ type: 'STATE_UPDATE', state, event: event ?? null });
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) slot.ws.send(msg);
    }
  }

  #sendTo(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  #notifyOther(room, senderId, payload) {
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (pid !== senderId && slot.ws?.readyState === 1) {
        slot.ws.send(JSON.stringify(payload));
      }
    }
  }

  async #closeRoom(room, reason) {
    room.status = 'finished';
    this.#clearAutoTimer(room.gameId);
    for (const slot of Object.values(room.slots)) clearTimeout(slot.reconnectTimer);
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) {
        slot.ws.send(JSON.stringify({ type: 'ROOM_CLOSED', reason }));
        slot.ws.close();
      }
    }
    this.#rooms.delete(room.gameId);
    logger.info('Oda kapandi', { gameId: room.gameId, reason });
  }

  stats() {
    return {
      rooms:   this.#rooms.size,
      playing: [...this.#rooms.values()].filter(r => r.status === 'playing').length,
      waiting: [...this.#rooms.values()].filter(r => r.status === 'waiting').length,
    };
  }
}
