// =========================================================
//  RoomManager
// =========================================================

import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import { saveGameState, loadGameState } from '../utils/redis.js';
import { logger }                    from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;   // 20 saniye — istekte belirtilen
const LOBBY_COUNTDOWN_MS   = 5_000;    // Özel lobide iki taraf da hazır olunca geri sayım

// "Otomatik" faz geçişleri için sunucu-taraflı süreler.
// Bu geçişler ARTIK hiçbir istemciye bağımlı değil — istemci
// bağlantısı kopsa, sekme arka plana atılsa, hatta iki taraf da
// tamamen kapatılsa bile sunucu bu geçişleri kendi başına yapar.
const AUTO_DELAYS = Object.freeze({
  [STATUS.ROUND_RESULT]: 3_000,
  [STATUS.COLLECTION]:   10_000,
  [STATUS.BATTLE]:       4_000,   // yalnızca revealed=false iken kullanılır
});

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

    // Her oyun türü (rastgele eşleşme, meydan okuma, davet, oda kodu) aynı
    // yoldan geçer: iki oyuncu bağlanınca oyun HEMEN başlamaz, oda 'lobby'
    // durumuna girer ve her iki taraf "hazır" diyene kadar bekler.
    if (this.#bothConnected(room) && room.status === 'waiting') {
      room.status = 'lobby';
      room.ready  = { player1: false, player2: false };
      await this.#broadcastLobby(room);
      logger.info('Lobi hazir, oyuncular bekleniyor', { gameId: room.gameId });
    } else if (room.status === 'lobby') {
      // Reconnect / geç katılım: mevcut lobi durumunu tazele
      await this.#broadcastLobby(room);
    }

    return { gameId: room.gameId, playerId };
  }

  /**
   * Bir oyuncu lobide "Hazırım" dedi.
   * İkisi de hazır olunca 5 saniyelik geri sayım başlatılır;
   * süre dolunca oyun sunucu tarafında başlatılır.
   */
  async setReady(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);

    if (!room) {
      this.#sendTo(ws, { type: 'ERROR', error: 'Oda bulunamadi.' }); return;
    }
    if (room.status !== 'lobby') {
      this.#sendTo(ws, { type: 'ERROR', error: 'Lobi aktif degil.' }); return;
    }

    room.ready[playerId] = true;
    logger.info('Oyuncu hazir', { gameId, playerId });
    await this.#broadcastLobby(room);

    if (room.ready.player1 && room.ready.player2) {
      const startsAt = Date.now() + LOBBY_COUNTDOWN_MS;
      this.#broadcastRaw(room, {
        type: 'LOBBY_COUNTDOWN_START',
        startsAt,
        durationMs: LOBBY_COUNTDOWN_MS,
      });
      room.countdownTimer = setTimeout(() => {
        this.#startPrivateGame(room).catch((err) => {
          logger.error('Lobi baslatma hatasi', { gameId: room.gameId, err: err.message });
        });
      }, LOBBY_COUNTDOWN_MS);
    }
  }

  async #startPrivateGame(room) {
    room.countdownTimer = null;
    // Geri sayım sırasında biri ayrılmış olabilir — oda o durumda zaten kapatılmıştır.
    if (room.status !== 'lobby') return;

    room.status = 'playing';
    const names = {
      player1: room.slots.player1.name ?? 'Oyuncu 1',
      player2: room.slots.player2.name ?? 'Oyuncu 2',
    };
    const result = room.engine.startGame(names);
    await this.#broadcast(room, room.engine.getState(), result.event);
    await saveGameState(room.gameId, room.engine.getState());
    logger.info('Lobi oyunu basladi', { gameId: room.gameId });
    this.#scheduleAuto(room);
  }

  async #broadcastLobby(room) {
    this.#broadcastRaw(room, {
      type: 'LOBBY_UPDATE',
      players: {
        player1: room.slots.player1.name ? { name: room.slots.player1.name } : null,
        player2: room.slots.player2.name ? { name: room.slots.player2.name } : null,
      },
      ready: { ...room.ready },
    });
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

    // Lobi modda (oyun henüz başlamadı) → geri sayım varsa iptal et,
    // rakibe bildir, oda kapanır (henüz korunacak bir oyun state'i yok)
    if (room.status === 'lobby') {
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      this.#notifyOther(room, playerId, { type: 'ROOM_CLOSED', reason: 'opponent_left' });
      this.#rooms.delete(gameId);
      logger.info('Lobi oda kaldirildi (oyuncu ayrildi)', { gameId, playerId });
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

    if (state.status === STATUS.BATTLE && state.battle?.revealed) {
      // Bu karşılaşma zaten açıldı; NEXT_BATTLE oyuncu aksiyonuyla
      // tetikleniyor, otomatik zamanlayıcı gerekmez.
      return;
    }

    const delay = AUTO_DELAYS[state.status];
    if (!delay) return;

    const actionType = {
      [STATUS.ROUND_RESULT]: ACTION_TYPES.ADVANCE_ROUND,
      [STATUS.COLLECTION]:   ACTION_TYPES.START_BATTLE,
      [STATUS.BATTLE]:       ACTION_TYPES.REVEAL_BATTLE,
    }[state.status];

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
      ready: { player1: false, player2: false },
      countdownTimer: null,
      engine: new GameEngine(),
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
      ready: { player1: false, player2: false },
      countdownTimer: null,
      engine: GameEngine.fromState(saved),
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
      [ACTION_TYPES.PLACE_BID]: (p) => p.bidderId === playerId,
      [ACTION_TYPES.PASS]:      (p) => p.passerId  === playerId,
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

  #broadcastRaw(room, payload) {
    const msg = JSON.stringify(payload);
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
    if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
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
