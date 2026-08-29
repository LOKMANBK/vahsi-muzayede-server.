// =========================================================
//  RoomManager — private lobi + forfeit desteği
// =========================================================

import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import { saveGameState, loadGameState } from '../utils/redis.js';
import { logger }                    from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;

export class RoomManager {
  #rooms = new Map();
  #reconnectMs;

  constructor(reconnectMs = DEFAULT_RECONNECT_MS) {
    this.#reconnectMs = reconnectMs;
  }

  async connect(ws, opts = {}) {
    let room, playerId;

    if (opts.gameId) {
      // Belirli odaya katıl (arkadaş kodu veya reconnect)
      room = await this.#getOrRestoreRoom(opts.gameId);
      playerId = this.#assignSlot(room, ws, opts.playerName);
    } else if (opts.privateLobby) {
      // Özel oda — matchmaking'e girme, sadece yeni oda aç
      room = this.#createRoom(true);
      playerId = this.#assignSlot(room, ws, opts.playerName);
    } else {
      // Rastgele eşleştirme — sadece public waiting odalar
      room = this.#findPublicWaitingRoom() ?? this.#createRoom(false);
      playerId = this.#assignSlot(room, ws, opts.playerName);
    }

    ws._gameId   = room.gameId;
    ws._playerId = playerId;

    logger.info('Oyuncu baglandi', { gameId: room.gameId, playerId, private: room.private });

    this.#sendTo(ws, {
      type: 'CONNECTED', gameId: room.gameId, playerId,
      state: room.engine.getState(),
    });

    // Public oda: iki kişi bağlanınca otomatik başlat
    // Private oda: START_PRIVATE_GAME bekle
    if (!room.private && this.#bothConnected(room) && room.status === 'waiting') {
      await this.#startGame(room);
    }

    // Private odaya ikinci oyuncu bağlandıysa her ikisine state gönder (isim güncellemesi)
    if (room.private && this.#bothConnected(room) && room.status === 'waiting') {
      await this.#broadcast(room, room.engine.getState(), null);
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

    if (room.status === 'waiting') {
      this.#rooms.delete(gameId);
      logger.info('Waiting oda kaldirildi', { gameId });
      return;
    }

    if (room.status === 'playing') {
      this.#notifyOther(room, playerId, {
        type: 'OPPONENT_DISCONNECTED', playerId,
        reconnectMs: this.#reconnectMs,
      });
      slot.reconnectTimer = setTimeout(async () => {
        logger.warn('Reconnect suresi doldu — forfeit', { gameId, playerId });
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

    // Private lobi başlatma
    if (action.type === 'START_PRIVATE_GAME') {
      if (room.status !== 'waiting') {
        this.#sendTo(ws, { type: 'ERROR', error: 'Oyun zaten basladi.' }); return;
      }
      if (!this.#bothConnected(room)) {
        this.#sendTo(ws, { type: 'ERROR', error: 'Iki oyuncu baglanmali.' }); return;
      }
      if (playerId !== 'player1') {
        this.#sendTo(ws, { type: 'ERROR', error: 'Sadece host baslatabilis.' }); return;
      }
      await this.#startGame(room);
      return;
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
    await this.#broadcast(room, newState, result.event);
    await saveGameState(gameId, newState);

    if (newState.status === STATUS.FINAL) {
      await this.#closeRoom(room, 'finished');
    }
  }

  async #startGame(room) {
    room.status = 'playing';
    const names = {
      player1: room.slots.player1.name ?? 'Oyuncu 1',
      player2: room.slots.player2.name ?? 'Oyuncu 2',
    };
    const result = room.engine.startGame(names);
    await this.#broadcast(room, room.engine.getState(), result.event);
    logger.info('Oyun basladi', { gameId: room.gameId, private: room.private });
  }

  async #forfeit(room, disconnectedPlayerId) {
    const winnerId = disconnectedPlayerId === 'player1' ? 'player2' : 'player1';
    const forfeitMsg = JSON.stringify({
      type: 'GAME_OVER_FORFEIT', winnerId,
      loserId: disconnectedPlayerId, reason: 'opponent_disconnected',
    });
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) slot.ws.send(forfeitMsg);
    }
    await this.#closeRoom(room, 'forfeit');
  }

  #createRoom(isPrivate = false) {
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = {
      gameId,
      private: isPrivate,
      status: 'waiting',
      engine: new GameEngine(),
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null },
      },
    };
    this.#rooms.set(gameId, room);
    logger.info('Oda olusturuldu', { gameId, private: isPrivate });
    return room;
  }

  async #getOrRestoreRoom(gameId) {
    if (this.#rooms.has(gameId)) return this.#rooms.get(gameId);
    const saved = await loadGameState(gameId);
    if (!saved) throw new Error('Oda bulunamadi: ' + gameId);
    const room = {
      gameId, private: false,
      status: saved.status === STATUS.FINAL ? 'finished' : 'playing',
      engine: GameEngine.fromState(saved),
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null },
      },
    };
    this.#rooms.set(gameId, room);
    return room;
  }

  // Sadece public (private olmayan) waiting odaları döndür
  #findPublicWaitingRoom() {
    for (const room of this.#rooms.values()) {
      if (room.status !== 'waiting' || room.private) continue;
      if (Object.values(room.slots).some(s => !s.ws && s.name === null)) return room;
    }
    return null;
  }

  #assignSlot(room, ws, name) {
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (slot.name === name && slot.ws === null && slot.awayAt !== null) {
        clearTimeout(slot.reconnectTimer);
        slot.ws = ws; slot.awayAt = null;
        logger.info('Reconnect', { gameId: room.gameId, playerId: pid });
        return pid;
      }
    }
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (!slot.ws && slot.name === null) {
        slot.ws = ws; slot.name = name ?? pid;
        return pid;
      }
    }
    throw new Error('Oda dolu.');
  }

  #bothConnected(room) {
    return room.slots.player1.ws !== null && room.slots.player2.ws !== null;
  }

  #authorize(action, playerId) {
    const checks = {
      [ACTION_TYPES.PLACE_BID]: (p) => p.bidderId === playerId,
      [ACTION_TYPES.PASS]:      (p) => p.passerId  === playerId,
    };
    const check = checks[action.type];
    if (check && !check(action.payload)) return 'Bu action sana ait degil.';
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
