// =========================================================
//  RoomManager
// =========================================================

import { randomBytes }               from 'crypto';
import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import { saveGameState, loadGameState } from '../utils/redis.js';
import { logger }                    from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;   // 20 saniye — istekte belirtilen

// Rate limiting: bir bağlantıdan saniyede en fazla bu kadar ACTION
const RATE_LIMIT_MAX     = 10;   // izin verilen action sayısı
const RATE_LIMIT_WINDOW  = 1000; // ms cinsinden pencere

/** Güvenli reconnect token üretir (64 hex karakter). */
function generateToken() {
  return randomBytes(32).toString('hex');
}

// İki oyuncu da "Hazırım" dedikten sonra maçın gerçekten başlamasına kadar
// geçen senkronize geri sayım süresi (istemci bu süre boyunca 5→1→GO gösterir).
// Test ortamında constructor'dan override edilebilir.
const DEFAULT_LOBBY_COUNTDOWN_MS = 5_000;

// "Otomatik" faz geçişleri için sunucu-taraflı süreler.
// Bu geçişler ARTIK hiçbir istemciye bağımlı değil — istemci
// bağlantısı kopsa, sekme arka plana atılsa, hatta iki taraf da
// tamamen kapatılsa bile sunucu bu geçişleri kendi başına yapar.
const DEFAULT_AUTO_DELAYS = Object.freeze({
  [STATUS.ROUND_RESULT]: 3_000,
  [STATUS.COLLECTION]:   10_000,
  [STATUS.BATTLE]:       5_000,
});
const DEFAULT_BATTLE_NEXT_DELAY_MS = 4_000;

// Maç bitince oda hemen kapanmaz — rövanş isteği için bu süre kadar açık kalır.
const REMATCH_WINDOW_MS = 45_000;

export class RoomManager {
  #rooms = new Map();
  #reconnectMs;
  #lobbyCountdownMs;
  #autoDelays;
  #battleNextDelayMs;
  #autoTimers   = new Map();
  #finishTimers = new Map();

  constructor({
    reconnectMs       = DEFAULT_RECONNECT_MS,
    lobbyCountdownMs  = DEFAULT_LOBBY_COUNTDOWN_MS,
    autoDelays        = DEFAULT_AUTO_DELAYS,
    battleNextDelayMs = DEFAULT_BATTLE_NEXT_DELAY_MS,
  } = {}) {
    this.#reconnectMs      = reconnectMs;
    this.#lobbyCountdownMs = lobbyCountdownMs;
    this.#autoDelays       = autoDelays;
    this.#battleNextDelayMs = battleNextDelayMs;
  }

  async connect(ws, opts = {}) {
    let room, playerId, reconnectToken;

    if (opts.gameId && opts.reconnectToken) {
      // Token ile reconnect — sadece token eşleşirse slot verilir
      room = await this.#getOrRestoreRoom(opts.gameId);
      ({ playerId, reconnectToken } = this.#assignSlot(room, ws, opts.playerName, opts.userId, opts.reconnectToken));
    } else if (opts.gameId) {
      // Arkadaş kodu ile özel odaya ilk katılım
      room = await this.#getOrRestoreRoom(opts.gameId);
      ({ playerId, reconnectToken } = this.#assignSlot(room, ws, opts.playerName, opts.userId));
    } else if (opts.privateLobby) {
      // Özel oda — matchmaking'e GIRME, yeni izole oda aç
      room = this.#createRoom(true);
      ({ playerId, reconnectToken } = this.#assignSlot(room, ws, opts.playerName, opts.userId));
    } else {
      // Rastgele eşleştirme — sadece public waiting odalar
      room = this.#findPublicWaitingRoom() ?? this.#createRoom(false);
      ({ playerId, reconnectToken } = this.#assignSlot(room, ws, opts.playerName, opts.userId));
    }

    ws._gameId   = room.gameId;
    ws._playerId = playerId;

    // Rate limiter state'i başlat
    ws._rateCount  = 0;
    ws._rateReset  = Date.now() + RATE_LIMIT_WINDOW;

    logger.info('Oyuncu baglandi', { gameId: room.gameId, playerId });
    this.#sendTo(ws, {
      type:           'CONNECTED',
      gameId:         room.gameId,
      playerId,
      reconnectToken,           // istemci bunu güvenli şekilde saklamalı
      state:          room.engine.getState(),
      nextAutoAt:     room.nextAutoAt ?? null,
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
    // ── Rate limiting ──────────────────────────────────────
    const now = Date.now();
    if (now > ws._rateReset) {
      ws._rateCount = 0;
      ws._rateReset = now + RATE_LIMIT_WINDOW;
    }
    ws._rateCount = (ws._rateCount ?? 0) + 1;
    if (ws._rateCount > RATE_LIMIT_MAX) {
      this.#sendTo(ws, { type: 'ERROR', error: 'Cok fazla istek. Lutfen bekleyin.' });
      logger.warn('Rate limit asildi', { playerId: ws._playerId, gameId: ws._gameId });
      return;
    }
    // ──────────────────────────────────────────────────────

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
    await this.#saveRoom(room);
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

    const startsAt = Date.now() + this.#lobbyCountdownMs;
    const msg = JSON.stringify({ type: 'LOBBY_COUNTDOWN_START', startsAt, durationMs: this.#lobbyCountdownMs });
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
      await this.#saveRoom(room);
      logger.info('Oyun basladi (lobi hazir)', { gameId: room.gameId });
    }, this.#lobbyCountdownMs);
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
    await this.#saveRoom(room);
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
      delay      = this.#battleNextDelayMs;
      actionType = ACTION_TYPES.NEXT_BATTLE;
    } else {
      delay = this.#autoDelays[state.status];
      actionType = {
        [STATUS.ROUND_RESULT]: ACTION_TYPES.ADVANCE_ROUND,
        // COLLECTION: #handleCollectionReady yönetiyor — otomatik timer yok.
        // İki oyuncu da hazır olunca anında geçer; biri bağlı değilse forfeit
        // mekanizması devreye girer. Burada START_BATTLE zamanlarsak
        // #handleCollectionReady ile çakışır.
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
    await this.#saveRoom(room);
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

    // İstatistikleri ve maç geçmişini sunucu tarafında kaydet
    this.#saveMatchStats(room).catch(err =>
      logger.error('Match stats kayit hatasi', { gameId: room.gameId, err: err.message })
    );

    const timer = setTimeout(() => {
      this.#finishTimers.delete(room.gameId);
      this.#closeRoom(room, 'finished').catch((err) => {
        logger.error('Finish-kapatma hatasi', { gameId: room.gameId, err: err.message });
      });
    }, REMATCH_WINDOW_MS);
    this.#finishTimers.set(room.gameId, timer);
  }

  /**
   * Maç bitince sunucu tarafında Supabase'e:
   * - Her oyuncunun xp, wins/losses, level, mmr güncellenir
   * - match_history'ye kayıt eklenir
   * Güvenli: client'a güvenmez, kendi hesaplar.
   */
  async #saveMatchStats(room) {
    const SUPABASE_URL        = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      logger.warn('Supabase env eksik — stats kaydedilmiyor');
      return;
    }

    const state  = room.engine.getState();
    if (!state.battle) return;

    const s1  = state.battle.scores.player1;
    const s2  = state.battle.scores.player2;
    const tie = s1 === s2;
    const winnerId = tie ? null : s1 > s2 ? 'player1' : 'player2';

    const p1Slot = room.slots.player1;
    const p2Slot = room.slots.player2;

    // userId yoksa güncelleme yapma (misafir/anonim)
    if (!p1Slot.userId && !p2Slot.userId) return;

    const headers = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=minimal',
    };

    // Her iki oyuncunun mevcut profilini çek
    const fetchProfile = async (uid) => {
      if (!uid) return null;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&limit=1`, {
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      const d = await r.json();
      return Array.isArray(d) && d.length ? d[0] : null;
    };

    const [p1Profile, p2Profile] = await Promise.all([
      fetchProfile(p1Slot.userId),
      fetchProfile(p2Slot.userId),
    ]);

    const MMR_K = 32;
    const calcMmrChange = (myMmr, oppMmr, won) => {
      const expected = 1 / (1 + Math.pow(10, (oppMmr - myMmr) / 400));
      return Math.round(MMR_K * ((won ? 1 : 0) - expected));
    };

    const XP_WIN = 100, XP_LOSE = 30;

    // Player1 stats
    let p1MmrChange = 0, p2MmrChange = 0;
    if (p1Profile && p2Profile) {
      const p1Won = winnerId === 'player1';
      const p2Won = winnerId === 'player2';
      p1MmrChange = calcMmrChange(p1Profile.mmr ?? 1000, p2Profile.mmr ?? 1000, p1Won);
      p2MmrChange = calcMmrChange(p2Profile.mmr ?? 1000, p1Profile.mmr ?? 1000, p2Won);
    }

    const updatePlayer = async (slot, profile, won, mmrChange) => {
      if (!slot.userId || !profile) return;
      const xp      = (profile.xp ?? 0)     + (won ? XP_WIN : XP_LOSE);
      const wins    = (profile.wins ?? 0)   + (won ? 1 : 0);
      const losses  = (profile.losses ?? 0) + (won ? 0 : 1);
      const level   = Math.max(1, Math.floor(xp / 500) + 1);
      const newMmr  = Math.max(0, (profile.mmr ?? 1000) + mmrChange);
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${slot.userId}`, {
        method:  'PATCH',
        headers,
        body: JSON.stringify({ xp, wins, losses, level, mmr: newMmr }),
      });
    };

    await Promise.all([
      updatePlayer(p1Slot, p1Profile, winnerId === 'player1', p1MmrChange),
      updatePlayer(p2Slot, p2Profile, winnerId === 'player2', p2MmrChange),
    ]);

    // Maç geçmişi kaydet (tek kayıt, her iki oyuncu bilgisi doğru)
    if (p1Slot.userId || p2Slot.userId) {
      await fetch(`${SUPABASE_URL}/rest/v1/match_history`, {
        method:  'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          room_id:        room.gameId,
          player1_id:     p1Slot.userId ?? null,
          player2_id:     p2Slot.userId ?? null,
          winner_id:      winnerId === 'player1' ? p1Slot.userId : winnerId === 'player2' ? p2Slot.userId : null,
          p1_score:       s1,
          p2_score:       s2,
          p1_mmr_change:  p1MmrChange,
          p2_mmr_change:  p2MmrChange,
        }),
      });
    }

    logger.info('Match stats kaydedildi', {
      gameId: room.gameId,
      winnerId,
      p1MmrChange,
      p2MmrChange,
    });
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
    await this.#saveRoom(room);
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

  #createRoom(isPrivate = false) {
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room   = {
      gameId,
      private: isPrivate,   // true → matchmaking'e girmez
      status: 'waiting',
      engine: new GameEngine(),
      collectionReady: { player1: false, player2: false },
      lobbyReady: { player1: false, player2: false },
      lobbyCountdownTimer: null,
      nextAutoAt: null,
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null, userId: null, reconnectToken: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null, userId: null, reconnectToken: null },
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
      gameId,
      status: saved.status === STATUS.FINAL ? 'finished' : 'playing',
      engine: GameEngine.fromState(saved),
      collectionReady: { player1: false, player2: false },
      lobbyReady: { player1: false, player2: false },
      lobbyCountdownTimer: null,
      nextAutoAt: null,
      rematch: { requestedBy: null },
      slots: {
        player1: { ws: null, name: null, awayAt: null, reconnectTimer: null, userId: null, reconnectToken: null },
        player2: { ws: null, name: null, awayAt: null, reconnectTimer: null, userId: null, reconnectToken: null },
      },
    };
    this.#rooms.set(gameId, room);
    return room;
  }

  #findFreshWaitingRoom() { return this.#findPublicWaitingRoom(); } // alias

  #findPublicWaitingRoom() {
    for (const room of this.#rooms.values()) {
      if (room.status !== 'waiting') continue;
      if (room.private) continue;   // özel odaları atlat
      const hasVirginSlot = Object.values(room.slots).some(s => !s.ws && s.name === null);
      if (hasVirginSlot) return room;
    }
    return null;
  }

  /**
   * Slot atar veya token ile reconnect yapar.
   *
   * Reconnect: opts.reconnectToken gereklidir; isim eşleşmesi güvenli
   * olmadığı için artık kabul edilmez. Token sunucu tarafından üretilip
   * ilk CONNECTED mesajında istemciye gönderilir; saklanması istemcinin
   * sorumluluğundadır.
   *
   * @returns {{ playerId: string, reconnectToken: string }}
   */
  #assignSlot(room, ws, name, userId = null, reconnectToken = null) {
    // Token tabanlı reconnect
    if (reconnectToken) {
      for (const [pid, slot] of Object.entries(room.slots)) {
        if (slot.reconnectToken === reconnectToken && slot.ws === null && slot.awayAt !== null) {
          clearTimeout(slot.reconnectTimer);
          slot.ws             = ws;
          slot.awayAt         = null;
          slot.reconnectTimer = null;
          if (userId) slot.userId = userId;
          // Rate limiter sıfırla
          ws._rateCount = 0;
          ws._rateReset = Date.now() + RATE_LIMIT_WINDOW;
          logger.info('Reconnect (token)', { gameId: room.gameId, playerId: pid });
          return { playerId: pid, reconnectToken: slot.reconnectToken };
        }
      }
      // Geçersiz/süresi dolmuş token — yeni slot tahsis etme, hata fırlat
      throw new Error('Reconnect token gecersiz veya suresi doldu.');
    }

    // Boş slot — yeni oyuncu
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (!slot.ws && slot.name === null) {
        const token        = generateToken();
        slot.ws            = ws;
        slot.name          = name ?? pid;
        slot.userId        = userId;
        slot.reconnectToken = token;
        return { playerId: pid, reconnectToken: token };
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

  /** _queue dahil tam engine state'ini Redis'e kaydeder. */
  async #saveRoom(room) {
    await saveGameState(room.gameId, JSON.parse(room.engine.serialize()));
  }

  stats() {
    return {
      rooms:   this.#rooms.size,
      playing: [...this.#rooms.values()].filter(r => r.status === 'playing').length,
      waiting: [...this.#rooms.values()].filter(r => r.status === 'waiting').length,
    };
  }
}
