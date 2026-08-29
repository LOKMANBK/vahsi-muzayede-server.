// =========================================================
//  RoomManager
// =========================================================

import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import { saveGameState, loadGameState } from '../utils/redis.js';
import { logger }                    from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;   // 20 saniye — istekte belirtilen

// İki oyuncu da "Hazırım" dedikten sonra maçın gerçekten başlamasına kadar
// geçen senkronize geri sayım süresi (istemci bu süre boyunca 5→1→GO gösterir).
const LOBBY_COUNTDOWN_MS = 5_000;

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

// Maç bitince oda hemen kapanmaz — rövanş isteği için bu süre kadar açık kalır.
const REMATCH_WINDOW_MS = 45_000;

export class RoomManager {
  #rooms = new Map();
  #reconnectMs;
  #autoTimers   = new Map();   // gameId -> Timeout
  #finishTimers = new Map();   // gameId -> Timeout (rövanş penceresi)

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
      nextAutoAt: room.nextAutoAt ?? null,
    });

    // Oyun otomatik başlamaz — her iki taraf da lobide "Hazırım" demeli.
    // Bkz. #handleLobbyReady.
    if (room.status === 'waiting') {
      this.#broadcastLobby(room);
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
      if (room.lobbyCountdownTimer) {
        clearTimeout(room.lobbyCountdownTimer);
        room.lobbyCountdownTimer = null;
      }
      this.#rooms.delete(gameId);
      logger.info('Waiting oda kaldirildi', { gameId });
      return;
    }

    // Maç bitmiş, rövanş penceresindeyken biri kopar/kapatırsa → rakibe
    // bildir, oda hemen kapansın (rövanş artık mümkün değil).
    if (room.status === 'finished') {
      this.#notifyOther(room, playerId, { type: 'OPPONENT_LEFT' });
      this.#clearFinishTimer(gameId);
      this.#rooms.delete(gameId);
      logger.info('Finished oda kaldirildi (oyuncu ayrildi)', { gameId, playerId });
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

    if (newState.status === STATUS.FINAL) {
      this.#clearAutoTimer(gameId);
      this.#enterFinished(room);
    } else {
      // İstemciden gelen her action, o an yürürlükte olan otomatik
      // zamanlayıcıyı geçersiz kılabilir (örn. oyuncu erken pas geçti,
      // ya da zaten sunucu otomatik ilerletmişti). Güncel duruma göre
      // zamanlayıcıyı her seferinde yeniden kur — broadcast'ten ÖNCE,
      // ki yayınlanan nextAutoAt her iki istemci için de aynı ve doğru olsun.
      this.#scheduleAuto(room);
    }

    await this.#broadcast(room, newState, result.event);
    await saveGameState(gameId, newState);
  }

  /**
   * Bir oyuncu "Hazırım" dediğinde çağrılır. Lobide (maç başlamadan önce)
   * ve collection fazında (maç ortasında, savaş öncesi) iki farklı akışı yönetir.
   */
  async handleReady(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);
    if (!room || !playerId) return;

    if (room.status === 'waiting') {
      return this.#handleLobbyReady(room, playerId);
    }
    if (room.status === 'playing') {
      return this.#handleCollectionReady(room, playerId);
    }
  }

  /**
   * Lobi: iki oyuncu da "Hazırım" dedikten sonra LOBBY_COUNTDOWN_MS'lik
   * senkronize bir geri sayım başlar; süre bitince sunucu maçı başlatır.
   */
  async #handleLobbyReady(room, playerId) {
    if (!room.lobbyReady) room.lobbyReady = { player1: false, player2: false };
    room.lobbyReady[playerId] = true;
    this.#broadcastLobby(room);

    const bothHere  = !!(room.slots.player1.ws && room.slots.player2.ws);
    const { player1, player2 } = room.lobbyReady;
    if (!bothHere || !(player1 && player2)) return;
    if (room.lobbyCountdownTimer) return; // zaten başlatıldı

    const startsAt = Date.now() + LOBBY_COUNTDOWN_MS;
    const msg = JSON.stringify({ type: 'LOBBY_COUNTDOWN_START', startsAt, durationMs: LOBBY_COUNTDOWN_MS });
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) slot.ws.send(msg);
    }
    logger.info('Lobi geri sayimi basladi', { gameId: room.gameId });

    room.lobbyCountdownTimer = setTimeout(async () => {
      room.lobbyCountdownTimer = null;
      // Geri sayım sırasında biri ayrılmış olabilir — oda artık yok ya da
      // durumu değişmiş olabilir, o zaman sessizce vazgeç.
      if (room.status !== 'waiting' || !this.#rooms.has(room.gameId)) return;

      room.status = 'playing';
      const names = {
        player1: room.slots.player1.name ?? 'Oyuncu 1',
        player2: room.slots.player2.name ?? 'Oyuncu 2',
      };
      const result = room.engine.startGame(names);
      this.#scheduleAuto(room);
      await this.#broadcast(room, room.engine.getState(), result.event);
      await saveGameState(room.gameId, room.engine.getState());
      logger.info('Oyun basladi (lobi hazir)', { gameId: room.gameId });
    }, LOBBY_COUNTDOWN_MS);
  }

  #broadcastLobby(room) {
    const players = {};
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (slot.name) players[pid] = { name: slot.name };
    }
    const ready = room.lobbyReady ?? { player1: false, player2: false };
    const msg = JSON.stringify({ type: 'LOBBY_UPDATE', players, ready });
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) slot.ws.send(msg);
    }
  }

  /**
   * Collection fazında (maç ortasında, savaş öncesi) "Hazırım".
   * Sunucu her iki oyuncunun da hazır durumunu tutar ve rakibe yayınlar —
   * böylece her istemci kendi hazır durumunu değil, gerçek/ortak durumu
   * görür. İkisi de hazır olduğunda oyun 10sn'lik zamanlayıcıyı beklemeden
   * hemen savaşa geçer.
   */
  async #handleCollectionReady(room, playerId) {
    const gameId = room.gameId;
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

    if (newState.status === STATUS.FINAL) {
      this.#enterFinished(room);
    } else {
      this.#scheduleAuto(room);
    }
    await this.#broadcast(room, newState, result.event);
    await saveGameState(gameId, newState);
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

    // Bu, o an planlanan geçişin GERÇEKLEŞECEĞİ mutlak zaman damgası.
    // İki oyuncunun istemcisi de görsel geri sayımı KENDİ tahminleriyle
    // (host/misafir farklı sabit gecikmelerle) değil, bu tek ve ortak
    // zaman damgasıyla senkronize eder — bu yüzden artık iki tarafta da
    // aynı saniyeyi gösterirler.
    room.nextAutoAt = Date.now() + delay;

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
    const room = this.#rooms.get(gameId);
    if (room) room.nextAutoAt = null;
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

    if (newState.status === STATUS.FINAL) {
      this.#clearAutoTimer(room.gameId);
      this.#enterFinished(room);
    } else {
      this.#scheduleAuto(room);
    }

    await this.#broadcast(room, newState, result.event);
    await saveGameState(room.gameId, newState);
  }

  // ── Rövanş ─────────────────────────────────────────────
  //
  // Maç bitince oda hemen kapanmaz: oyuncular REMATCH_WINDOW_MS boyunca
  // aynı odada kalır. Bir oyuncu rövanş isteyip diğeri kabul ederse aynı
  // oda ve aynı iki oyuncuyla sıfırdan bir oyun başlar. Reddedilirse ya da
  // biri "Ana Menüye Dön"e basarsa oda kapanır.

  #enterFinished(room) {
    room.status  = 'finished';
    room.rematch = { requestedBy: null };
    this.#clearFinishTimer(room.gameId);
    const timer = setTimeout(() => {
      this.#finishTimers.delete(room.gameId);
      this.#closeRoom(room, 'finished').catch((err) => {
        logger.error('Finish-kapatma hatasi', { gameId: room.gameId, err: err.message });
      });
    }, REMATCH_WINDOW_MS);
    this.#finishTimers.set(room.gameId, timer);
  }

  #clearFinishTimer(gameId) {
    const timer = this.#finishTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.#finishTimers.delete(gameId);
    }
  }

  /** Bir oyuncu rövanş ister — rakibe bildirilir. */
  async requestRematch(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);
    if (!room || room.status !== 'finished' || !playerId) return;

    room.rematch.requestedBy = playerId;
    logger.info('Rovans istendi', { gameId, playerId });
    this.#notifyOther(room, playerId, { type: 'REMATCH_REQUESTED', fromPlayerId: playerId });
  }

  /** İstek alan oyuncu kabul eder ya da reddeder. */
  async respondRematch(ws, accepted) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);
    if (!room || room.status !== 'finished' || !playerId) return;

    const requesterId = room.rematch?.requestedBy;
    if (!requesterId || requesterId === playerId) return; // aktif istek yok / kendi isteğine cevap olmaz

    if (!accepted) {
      logger.info('Rovans reddedildi', { gameId, playerId });
      this.#notifyOther(room, playerId, { type: 'REMATCH_DECLINED' });
      room.rematch.requestedBy = null;
      await this.#closeRoom(room, 'rematch_declined');
      return;
    }

    this.#clearFinishTimer(gameId);
    const names = {
      player1: room.slots.player1.name ?? 'Oyuncu 1',
      player2: room.slots.player2.name ?? 'Oyuncu 2',
    };
    room.status          = 'playing';
    room.rematch         = { requestedBy: null };
    room.collectionReady = { player1: false, player2: false };
    room.engine          = new GameEngine();
    const result = room.engine.startGame(names);
    this.#scheduleAuto(room);

    logger.info('Rovans kabul edildi — yeni oyun basladi', { gameId });
    await this.#broadcast(room, room.engine.getState(), result.event);
    await saveGameState(gameId, room.engine.getState());
  }

  /** Maç bitiş ekranından "Ana Menüye Dön" — rakibe bildirilir, oda kapanır. */
  async leaveFinal(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    const room = this.#rooms.get(gameId);
    if (!room || room.status !== 'finished' || !playerId) return;

    this.#notifyOther(room, playerId, { type: 'OPPONENT_LEFT' });
    this.#clearFinishTimer(gameId);
    await this.#closeRoom(room, 'opponent_left');
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
      lobbyReady: { player1: false, player2: false },
      lobbyCountdownTimer: null,
      nextAutoAt: null,
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
      lobbyReady: { player1: false, player2: false },
      lobbyCountdownTimer: null,
      nextAutoAt: null,
      rematch: { requestedBy: null },
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
    const msg = JSON.stringify({
      type: 'STATE_UPDATE',
      state,
      event: event ?? null,
      nextAutoAt: room.nextAutoAt ?? null,
    });
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
    this.#clearFinishTimer(room.gameId);
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
