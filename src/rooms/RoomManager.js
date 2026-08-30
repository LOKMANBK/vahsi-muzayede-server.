// =========================================================
//  RoomManager
//
//  ÇOKLU INSTANCE DESTEĞİ
//  ────────────────────────────────────────────────────────
//  Önceki sürümde oda state'i (lobi dahil) SADECE bu process'in
//  belleğinde (#rooms Map) tutuluyordu. Sunucu birden fazla
//  instance/replika ile çalıştığında (Railway'de Replicas > 1
//  ya da autoscaling), arkadaş kodu ile katılan ya da düello
//  daveti kabul eden ikinci oyuncu farklı bir instance'a
//  düşebiliyordu — o instance'ın belleğinde oda hiç yoktu ve
//  iki taraf asla aynı odada buluşamıyordu.
//
//  Şimdi:
//   1. Oda kaydı (slots, status, lobi/hazır durumları, engine
//      state) lobi aşamasından itibaren Redis'e yazılıyor
//      (saveRoomRecord / loadRoomRecord).
//   2. Bir instance odayı yerelde bulamazsa Redis'ten geri
//      yüklüyor (#getOrRestoreRoom).
//   3. Odayı etkileyen her mutasyon (JOIN, ACTION, READY,
//      disconnect, rövanş...) işlemden hemen önce Redis'ten
//      TAZE veri ile senkronize ediliyor ve bir dağıtık kilit
//      (withRoomLock) altında yapılıyor — böylece iki instance
//      aynı odayı aynı anda güncelleyip birbirinin üzerine
//      yazamıyor.
//   4. Tüm broadcast'ler artık doğrudan ws.send() ile değil,
//      Redis pub/sub kanalından yayınlanıyor; HER instance
//      (yayınlayan dahil) bunu dinleyip SADECE kendi yerel
//      soketlerine iletiyor. Böylece iki oyuncu farklı
//      instance'larda olsa bile ikisi de güncellemeleri görür.
//
//  Tek instance / REDIS_URL yokken (yerel geliştirme, testler):
//  redis.js in-memory stub + process-içi event bus kullanır,
//  davranış eskisiyle birebir aynı kalır.
// =========================================================

import { randomBytes }               from 'crypto';
import { GameEngine }                from '../game/GameEngine.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { STATUS }                    from '../game/GameState.js';
import {
  saveRoomRecord, loadRoomRecord, deleteRoomRecord,
  publishRoomEvent, subscribeRoomEvents, withRoomLock,
} from '../utils/redis.js';
import { logger } from '../utils/logger.js';

const DEFAULT_RECONNECT_MS = 20_000;   // 20 saniye — istekte belirtilen

// AUCTION durumunda aktif teklif sahibinin hamle yapması için tanınan süre.
// Bağlı ama pasif kalan (ne teklif veren ne pas geçen) bir oyuncu bu süre
// dolunca sunucu tarafından otomatik pas geçmiş sayılır — böylece rakibini
// süresiz kilitleyemez. Disconnect zaten ayrı bir forfeit akışıyla ele
// alınıyor; bu, BAĞLI ama oyalayan oyuncu için ek bir koruma.
const DEFAULT_BID_TIMEOUT_MS = 8_000;

// Rate limiting: bir bağlantıdan saniyede en fazla bu kadar ACTION
const RATE_LIMIT_MAX     = 10;   // izin verilen action sayısı
const RATE_LIMIT_WINDOW  = 1000; // ms cinsinden pencere

/** Güvenli reconnect token üretir (64 hex karakter). */
function generateToken() {
  return randomBytes(32).toString('hex');
}

// İki oyuncu da "Hazırım" dedikten sonra maçın gerçekten başlamasına kadar
// geçen senkronize geri sayım süresi (istemci bu süre boyunca 5→1→GO gösterir).
const DEFAULT_LOBBY_COUNTDOWN_MS = 5_000;

// "Otomatik" faz geçişleri için sunucu-taraflı süreler.
const DEFAULT_AUTO_DELAYS = Object.freeze({
  [STATUS.ROUND_RESULT]: 5_000,   // 5 sn — hayvan uçuş animasyonu için yeterli süre
  [STATUS.COLLECTION]:   10_000,
  [STATUS.BATTLE]:       5_000,   // "savaşıyor…" bekleme süresi
});
const DEFAULT_BATTLE_NEXT_DELAY_MS = 4_000;

// Maç bitince oda hemen kapanmaz — rövanş isteği için bu süre kadar açık kalır.
const REMATCH_WINDOW_MS = 45_000;

/** Bir slot'un "şu an dolu ve bağlı" sayılıp sayılmadığı — WS'in HANGİ
 *  instance'ta olduğuna bakmaz, sadece isim atanmış ve "away" işaretlenmemiş
 *  mi ona bakar. Çoklu instance'ta doğru presence kontrolü budur; ham
 *  `slot.ws` sadece BU instance'ın yerel soketi olup olmadığını gösterir. */
function slotPresent(slot) {
  return !!slot?.name && slot.awayAt == null;
}

export class RoomManager {
  #rooms = new Map();
  #reconnectMs;
  #lobbyCountdownMs;
  #autoDelays;
  #battleNextDelayMs;
  #bidTimeoutMs;
  #autoTimers   = new Map();
  #finishTimers = new Map();
  #subscribed   = false;

  constructor({
    reconnectMs       = DEFAULT_RECONNECT_MS,
    lobbyCountdownMs  = DEFAULT_LOBBY_COUNTDOWN_MS,
    autoDelays        = DEFAULT_AUTO_DELAYS,
    battleNextDelayMs = DEFAULT_BATTLE_NEXT_DELAY_MS,
    bidTimeoutMs      = DEFAULT_BID_TIMEOUT_MS,
  } = {}) {
    this.#reconnectMs      = reconnectMs;
    this.#lobbyCountdownMs = lobbyCountdownMs;
    this.#autoDelays       = autoDelays;
    this.#battleNextDelayMs = battleNextDelayMs;
    this.#bidTimeoutMs     = bidTimeoutMs;

    // Diğer instance'lardan (ya da tek-instance'ta kendi yayınlarımızdan)
    // gelen oda olaylarını dinle ve yerel soketlere ilet.
    subscribeRoomEvents((gameId, msg) => this.#onRemoteRoomEvent(gameId, msg))
      .catch((err) => logger.error('Pub/sub abonelik hatasi', { err: err.message }));
  }

  async connect(ws, opts = {}) {
    let room, playerId, reconnectToken;

    if (opts.gameId) {
      // Arkadaş kodu / reconnect — kilit altında: taze veriyi çek, slot ata,
      // hemen kaydet. Böylece iki farklı instance aynı odaya aynı anda
      // yazmaya çalışsa bile çakışma olmaz.
      ({ room, playerId, reconnectToken } = await withRoomLock(opts.gameId, async () => {
        const r = await this.#getOrRestoreRoom(opts.gameId);
        const a = this.#assignSlot(r, ws, opts.playerName, opts.userId, opts.reconnectToken);
        await this.#persistRoom(r);
        return { room: r, ...a };
      }));
    } else if (opts.privateLobby) {
      // Özel oda — matchmaking'e GIRME, yeni izole oda aç
      room = this.#createRoom(true);
      ({ playerId, reconnectToken } = await withRoomLock(room.gameId, async () => {
        const a = this.#assignSlot(room, ws, opts.playerName, opts.userId);
        await this.#persistRoom(room);
        return a;
      }));
    } else {
      // Rastgele eşleştirme — sadece public waiting odalar
      room = this.#findPublicWaitingRoom() ?? this.#createRoom(false);
      ({ playerId, reconnectToken } = await withRoomLock(room.gameId, async () => {
        const a = this.#assignSlot(room, ws, opts.playerName, opts.userId);
        await this.#persistRoom(room);
        return a;
      }));
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
    if (room.status === 'waiting') {
      await this.#broadcastLobby(room);
    } else if (room.status === 'playing') {
      // Reconnect sonrası: rakip hâlâ oyundaysa güncel state'i tekrar
      // ver (yukarıdaki CONNECTED içinde zaten var, ekstra işlem gerekmez).
    }

    return { gameId: room.gameId, playerId };
  }

  async disconnect(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    if (!gameId || !playerId) return;

    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room) return;
      const slot = room.slots[playerId];
      if (!slot) return;
      // Başka bir soket bu arada bu slotu devralmış olabilir (reconnect
      // yarışı) — sadece hâlâ bizim soketimizse temizle.
      if (slot.ws && slot.ws !== ws) return;

      slot.ws     = null;
      slot.awayAt = Date.now();
      logger.info('Oyuncu ayrildi', { gameId, playerId });

      if (room.status === 'waiting') {
        // ÖNCEDEN: oda burada HEMEN siliniyordu — kısa bir ağ kopması,
        // sekmenin arka plana alınması ya da bir proxy'nin boşta bağlantıyı
        // kesmesi (bkz. ws sunucusunda ping aralığı) davet kodunu anında
        // ve kalıcı olarak geçersiz kılıyordu. Arkadaş kodu ya da düello
        // daveti tam bu yüzden "aynı odada buluşamıyorlardı".
        //
        // Şimdi 'playing' durumundaki gibi bir yeniden bağlanma penceresi
        // tanınıyor: oyuncu #reconnectMs içinde geri dönerse (aynı
        // reconnectToken ile) oda ve slotu korunur; dönmezse süre sonunda
        // temizlenir.
        if (room.lobbyCountdownTimer) {
          clearTimeout(room.lobbyCountdownTimer);
          room.lobbyCountdownTimer = null;
        }
        if (room.lobbyReady) room.lobbyReady[playerId] = false;
        await this.#persistRoom(room);
        await this.#broadcastLobby(room);

        slot.reconnectTimer = setTimeout(async () => {
          try {
            await withRoomLock(gameId, async () => {
              const fresh = await this.#getOrRestoreRoom(gameId).catch(() => null);
              if (!fresh || fresh.status !== 'waiting') return;
              // Bu arada geri bağlanmış olabilir — hâlâ away mi kontrol et.
              if (fresh.slots[playerId]?.awayAt == null) return;
              this.#clearAutoTimer(gameId);
              if (fresh.lobbyCountdownTimer) {
                clearTimeout(fresh.lobbyCountdownTimer);
                fresh.lobbyCountdownTimer = null;
              }
              await deleteRoomRecord(gameId);
              this.#rooms.delete(gameId);
              logger.info('Waiting oda kaldirildi (reconnect suresi doldu)', { gameId, playerId });
            });
          } catch (err) {
            logger.error('Waiting oda kaldirma hatasi', { gameId, err: err.message });
          }
        }, this.#reconnectMs);
        return;
      }

      if (room.status === 'finished') {
        await this.#notifyOther(room, playerId, { type: 'OPPONENT_LEFT' });
        this.#clearFinishTimer(gameId);
        await deleteRoomRecord(gameId);
        this.#rooms.delete(gameId);
        logger.info('Finished oda kaldirildi (oyuncu ayrildi)', { gameId, playerId });
        return;
      }

      if (room.status === 'playing') {
        await this.#persistRoom(room);
        await this.#notifyOther(room, playerId, {
          type: 'OPPONENT_DISCONNECTED',
          playerId,
          reconnectMs: this.#reconnectMs,
        });

        slot.reconnectTimer = setTimeout(async () => {
          logger.warn('Reconnect suresi doldu', { gameId, playerId });
          await this.#forfeit(room, playerId);
        }, this.#reconnectMs);
      }
    }).catch((err) => logger.error('disconnect hatasi', { gameId, err: err.message }));
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
    if (!gameId) { this.#sendTo(ws, { type: 'ERROR', error: 'Oda bulunamadi.' }); return; }

    try {
      await withRoomLock(gameId, async () => {
        const room = await this.#getOrRestoreRoom(gameId);

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
          this.#scheduleAuto(room);
        }

        await this.#persistRoom(room);
        await this.#broadcast(room, newState, result.event);
      });
    } catch (err) {
      logger.error('handleAction hatasi', { gameId, err: err.message });
      this.#sendTo(ws, { type: 'ERROR', error: 'Sunucu hatasi.' });
    }
  }

  /**
   * Bir oyuncu "Hazırım" dediğinde çağrılır. Lobide (maç başlamadan önce)
   * ve collection fazında (maç ortasında, savaş öncesi) iki farklı akışı yönetir.
   */
  async handleReady(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    if (!gameId || !playerId) return;

    try {
      await withRoomLock(gameId, async () => {
        const room = await this.#getOrRestoreRoom(gameId);
        if (room.status === 'waiting') {
          await this.#handleLobbyReady(room, playerId);
        } else if (room.status === 'playing') {
          await this.#handleCollectionReady(room, playerId);
        }
      });
    } catch (err) {
      logger.error('handleReady hatasi', { gameId, err: err.message });
    }
  }

  /**
   * Lobi: iki oyuncu da "Hazırım" dedikten sonra LOBBY_COUNTDOWN_MS'lik
   * senkronize bir geri sayım başlar; süre bitince sunucu maçı başlatır.
   */
  async #handleLobbyReady(room, playerId) {
    if (!room.lobbyReady) room.lobbyReady = { player1: false, player2: false };
    room.lobbyReady[playerId] = true;
    await this.#persistRoom(room);
    await this.#broadcastLobby(room);

    // "İkisi de burada mı?" artık ws referansına değil, kalıcı slot
    // bilgisine (isim atanmış + away değil) bakılarak belirleniyor —
    // rakip başka bir instance'a bağlı olsa bile doğru sonuç verir.
    const bothHere  = slotPresent(room.slots.player1) && slotPresent(room.slots.player2);
    const { player1, player2 } = room.lobbyReady;
    if (!bothHere || !(player1 && player2)) return;
    if (room.lobbyCountdownTimer) return; // zaten başlatıldı (bu instance'ta)

    const startsAt = Date.now() + this.#lobbyCountdownMs;
    await this.#broadcast(room, null, null, {
      type: 'LOBBY_COUNTDOWN_START', startsAt, durationMs: this.#lobbyCountdownMs,
    });
    logger.info('Lobi geri sayimi basladi', { gameId: room.gameId });

    room.lobbyCountdownTimer = setTimeout(async () => {
      room.lobbyCountdownTimer = null;
      try {
        await withRoomLock(room.gameId, async () => {
          const fresh = await this.#getOrRestoreRoom(room.gameId);
          if (fresh.status !== 'waiting') return; // bu arada biri ayrılmış/durum değişmiş olabilir

          fresh.status = 'playing';
          const names = {
            player1: fresh.slots.player1.name ?? 'Oyuncu 1',
            player2: fresh.slots.player2.name ?? 'Oyuncu 2',
          };
          const result = fresh.engine.startGame(names);
          this.#scheduleAuto(fresh);
          await this.#persistRoom(fresh);
          await this.#broadcast(fresh, fresh.engine.getState(), result.event);
          logger.info('Oyun basladi (lobi hazir)', { gameId: fresh.gameId });
        });
      } catch (err) {
        logger.error('Lobi baslatma hatasi', { gameId: room.gameId, err: err.message });
      }
    }, this.#lobbyCountdownMs);
  }

  async #broadcastLobby(room) {
    const players = {};
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (slot.name) players[pid] = { name: slot.name };
    }
    const ready = room.lobbyReady ?? { player1: false, player2: false };
    await this.#broadcast(room, null, null, { type: 'LOBBY_UPDATE', players, ready });
  }

  /**
   * Collection fazında (maç ortasında, savaş öncesi) "Hazırım".
   */
  async #handleCollectionReady(room, playerId) {
    const gameId = room.gameId;
    const state = room.engine.getState();
    if (state.status !== STATUS.COLLECTION) return;

    room.collectionReady[playerId] = true;
    await this.#persistRoom(room);
    await this.#broadcastReady(room);

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
    await this.#persistRoom(room);
    await this.#broadcast(room, newState, result.event);
  }

  /** collection fazına yeni girildiyse hazır durumlarını sıfırlar. */
  #syncCollectionReady(room, newState) {
    if (newState.status === STATUS.COLLECTION) {
      room.collectionReady = { player1: false, player2: false };
    }
  }

  async #broadcastReady(room) {
    await this.#broadcast(room, null, null, { type: 'READY_UPDATE', ready: { ...room.collectionReady } });
  }

  // ── Otomatik faz ilerletme (sunucu-taraflı, istemciden bağımsız) ──

  #scheduleAuto(room) {
    this.#clearAutoTimer(room.gameId);
    if (room.status !== 'playing') return;

    const state = room.engine.getState();

    // AUCTION: sabit bir action tipi/payload'u yok — zaman aşımında pas
    // geçecek kişi her seferinde değişen aktif teklif sahibi. Bu yüzden
    // diğer fazlardan (ROUND_RESULT/COLLECTION/BATTLE) ayrı ele alınır.
    if (state.status === STATUS.AUCTION) {
      const delay = this.#bidTimeoutMs;
      const activeBidderId = state.auction.activeBidderId;
      room.nextAutoAt = Date.now() + delay;

      const timer = setTimeout(() => {
        this.#autoPassAuction(room.gameId, activeBidderId).catch((err) => {
          logger.error('Bid timeout hatasi', { gameId: room.gameId, err: err.message });
        });
      }, delay);

      this.#autoTimers.set(room.gameId, timer);
      return;
    }

    let delay, actionType;
    if (state.status === STATUS.BATTLE && state.battle?.revealed) {
      delay      = this.#battleNextDelayMs;
      actionType = ACTION_TYPES.NEXT_BATTLE;
    } else {
      delay = this.#autoDelays[state.status];
      actionType = {
        [STATUS.ROUND_RESULT]: ACTION_TYPES.ADVANCE_ROUND,
        [STATUS.COLLECTION]:   ACTION_TYPES.START_BATTLE,
        [STATUS.BATTLE]:       ACTION_TYPES.REVEAL_BATTLE,
      }[state.status];
    }
    if (!delay) return;

    room.nextAutoAt = Date.now() + delay;

    const timer = setTimeout(() => {
      this.#autoAdvance(room.gameId, actionType).catch((err) => {
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

  async #autoAdvance(gameId, actionType) {
    this.#autoTimers.delete(gameId);

    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'playing') return;

      const result = applyAction(room.engine, { type: actionType, payload: {} });
      if (!result.ok) {
        logger.debug('Otomatik aksiyon uygulanamadi', { gameId, actionType, error: result.error });
        return;
      }

      const newState = room.engine.getState();
      this.#syncCollectionReady(room, newState);
      logger.info('Otomatik faz gecisi', { gameId, actionType, newStatus: newState.status });

      if (newState.status === STATUS.FINAL) {
        this.#clearAutoTimer(gameId);
        this.#enterFinished(room);
      } else {
        this.#scheduleAuto(room);
      }

      await this.#persistRoom(room);
      await this.#broadcast(room, newState, result.event);
    });
  }

  /**
   * Bid timer zaman aşımı: aktif teklif sahibi süresi içinde hamle
   * yapmadıysa onun adına otomatik PASS uygular. Teklif zaten VARSA
   * bu, o oyuncunun mevcut en yüksek teklife karşı vazgeçmesi demektir
   * (klasik pas). Teklif YOKSA sıra rakibe geçer (bkz. AuctionEngine.pass).
   * Bağlı-ama-pasif (disconnect olmayan) bir oyuncunun rakibini
   * süresiz kilitlemesini engeller.
   */
  async #autoPassAuction(gameId, expectedBidderId) {
    this.#autoTimers.delete(gameId);

    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'playing') return;

      const state = room.engine.getState();
      // Durum bu arada değişmiş (ör. oyuncu tam zamanında hamle yapmış)
      // ya da aktif teklif sahibi artık farklıysa — zamanlayıcı bayat,
      // yoksay.
      if (state.status !== STATUS.AUCTION) return;
      if (state.auction.activeBidderId !== expectedBidderId) return;

      const result = applyAction(room.engine, {
        type:    ACTION_TYPES.PASS,
        payload: { passerId: expectedBidderId },
      });
      if (!result.ok) {
        logger.debug('Bid timeout otomatik pas uygulanamadi', { gameId, error: result.error });
        return;
      }

      const newState = room.engine.getState();
      this.#syncCollectionReady(room, newState);
      logger.info('Bid timeout — otomatik pas uygulandi', { gameId, passerId: expectedBidderId, newStatus: newState.status });

      if (newState.status === STATUS.FINAL) {
        this.#clearAutoTimer(gameId);
        this.#enterFinished(room);
      } else {
        this.#scheduleAuto(room);
      }

      await this.#persistRoom(room);
      await this.#broadcast(room, newState, { ...result.event, timedOut: true });
    });
  }

  // ── Rövanş ─────────────────────────────────────────────

  #enterFinished(room) {
    room.status  = 'finished';
    room.rematch = { requestedBy: null };
    this.#clearFinishTimer(room.gameId);

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

    if (!p1Slot.userId && !p2Slot.userId) return;

    const headers = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=minimal',
    };

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

    if (p1Slot.userId || p2Slot.userId) {
      await fetch(`${SUPABASE_URL}/rest/v1/match_history`, {
        method:  'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          room_id:        room.gameId,
          player1_id:     p1Slot.userId ?? null,
          player2_id:     p2Slot.userId ?? null,
          p1_username:    p1Profile?.username ?? p1Slot.name ?? null,
          p2_username:    p2Profile?.username ?? p2Slot.name ?? null,
          winner_id:      winnerId === 'player1' ? p1Slot.userId : winnerId === 'player2' ? p2Slot.userId : null,
          p1_score:       s1,
          p2_score:       s2,
          p1_mmr_change:  p1MmrChange,
          p2_mmr_change:  p2MmrChange,
        }),
      });
    }

    logger.info('Match stats kaydedildi', { gameId: room.gameId, winnerId, p1MmrChange, p2MmrChange });
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
    if (!gameId || !playerId) return;
    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'finished') return;
      room.rematch.requestedBy = playerId;
      await this.#persistRoom(room);
      logger.info('Rovans istendi', { gameId, playerId });
      await this.#notifyOther(room, playerId, { type: 'REMATCH_REQUESTED', fromPlayerId: playerId });
    });
  }

  /** İstek alan oyuncu kabul eder ya da reddeder. */
  async respondRematch(ws, accepted) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    if (!gameId || !playerId) return;
    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'finished') return;

      const requesterId = room.rematch?.requestedBy;
      if (!requesterId || requesterId === playerId) return;

      if (!accepted) {
        logger.info('Rovans reddedildi', { gameId, playerId });
        await this.#notifyOther(room, playerId, { type: 'REMATCH_DECLINED' });
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
      await this.#persistRoom(room);
      await this.#broadcast(room, room.engine.getState(), result.event);
    });
  }

  /** Maç bitiş ekranından "Ana Menüye Dön" — rakibe bildirilir, oda kapanır. */
  async leaveFinal(ws) {
    const { _gameId: gameId, _playerId: playerId } = ws;
    if (!gameId || !playerId) return;
    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'finished') return;
      await this.#notifyOther(room, playerId, { type: 'OPPONENT_LEFT' });
      this.#clearFinishTimer(gameId);
      await this.#closeRoom(room, 'opponent_left');
    });
  }

  // ── Forfeit: kopan oyuncu kaybeder ────────────────────────
  async #forfeit(room, disconnectedPlayerId) {
    await withRoomLock(room.gameId, async () => {
      const fresh = await this.#getOrRestoreRoom(room.gameId).catch(() => null);
      if (!fresh || fresh.status !== 'playing') return;
      // Bu arada geri bağlanmış olabilir — hâlâ away mi kontrol et.
      if (fresh.slots[disconnectedPlayerId]?.awayAt == null) return;

      const winnerId = disconnectedPlayerId === 'player1' ? 'player2' : 'player1';
      logger.info('Forfeit', { gameId: fresh.gameId, loser: disconnectedPlayerId, winner: winnerId });

      await this.#broadcast(fresh, null, null, {
        type: 'GAME_OVER_FORFEIT',
        winnerId,
        loserId: disconnectedPlayerId,
        reason: 'opponent_disconnected',
      });

      await this.#closeRoom(fresh, 'forfeit');
    });
  }

  // ── Özel yardımcılar ─────────────────────────────────────

  #createRoom(isPrivate = false) {
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room   = {
      gameId,
      private: isPrivate,
      status: 'waiting',
      engine: new GameEngine(),
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
    logger.info('Oda olusturuldu', { gameId, private: isPrivate });
    return room;
  }

  /**
   * Odayı yerel bellekten döndürür; yoksa Redis'ten geri yükler; oradan da
   * bulunamazsa hata fırlatır. Yerelde ZATEN varsa bile Redis'teki en güncel
   * durumla senkronize eder (başka bir instance bu arada odayı güncellemiş
   * olabilir) — ama bu instance'ın elinde tuttuğu CANLI soket referanslarını
   * (`slot.ws`, `reconnectTimer`) asla ezmez, çünkü o bilgi sadece burada var.
   */
  async #getOrRestoreRoom(gameId) {
    const local  = this.#rooms.get(gameId) ?? null;
    const record = await loadRoomRecord(gameId);

    if (!local && !record) {
      throw new Error('Oda bulunamadi: ' + gameId);
    }

    if (!local) {
      // Bu instance'ta hiç yok — Redis kaydından yeni bir yerel gölge oluştur.
      const room = {
        gameId,
        private: !!record.private,
        status:  record.status,
        engine:  record.engineState ? GameEngine.fromState(record.engineState) : new GameEngine(),
        collectionReady: record.collectionReady ?? { player1: false, player2: false },
        lobbyReady:      record.lobbyReady ?? { player1: false, player2: false },
        lobbyCountdownTimer: null,
        nextAutoAt: record.nextAutoAt ?? null,
        rematch: record.rematch ?? { requestedBy: null },
        slots: {
          player1: { ws: null, reconnectTimer: null, ...record.slots.player1 },
          player2: { ws: null, reconnectTimer: null, ...record.slots.player2 },
        },
      };
      this.#rooms.set(gameId, room);
      return room;
    }

    if (record) {
      // Yerelde var — Redis'teki daha taze paylaşılan alanları uygula,
      // ama CANLI (bu instance'a özgü) alanlara dokunma.
      local.private         = !!record.private;
      local.status          = record.status;
      local.collectionReady = record.collectionReady ?? local.collectionReady;
      local.lobbyReady      = record.lobbyReady ?? local.lobbyReady;
      local.rematch         = record.rematch ?? local.rematch;
      if (record.engineState) local.engine = GameEngine.fromState(record.engineState);
      for (const pid of ['player1', 'player2']) {
        const r = record.slots[pid];
        if (!r) continue;
        local.slots[pid].name           = r.name;
        local.slots[pid].userId         = r.userId;
        local.slots[pid].reconnectToken = r.reconnectToken;
        // awayAt: sadece BAŞKA bir instance daha yeni bir bilgiye sahipse al.
        // Basit kural: Redis'te away işaretliyse ve burada değilse, ve bu
        // slotun soketi bu instance'ta değilse (ws null), Redis'e güven.
        if (r.awayAt != null && local.slots[pid].ws == null) {
          local.slots[pid].awayAt = r.awayAt;
        } else if (r.awayAt == null && local.slots[pid].ws) {
          local.slots[pid].awayAt = null;
        }
      }
    }

    return local;
  }

  #findPublicWaitingRoom() {
    for (const room of this.#rooms.values()) {
      if (room.status !== 'waiting') continue;
      if (room.private) continue;
      const hasVirginSlot = Object.values(room.slots).some(s => !s.ws && s.name === null);
      if (hasVirginSlot) return room;
    }
    return null;
  }

  /**
   * Slot atar veya token ile reconnect yapar.
   *
   * @returns {{ playerId: string, reconnectToken: string }}
   */
  #assignSlot(room, ws, name, userId = null, reconnectToken = null) {
    if (reconnectToken) {
      for (const [pid, slot] of Object.entries(room.slots)) {
        if (slot.reconnectToken === reconnectToken && slot.ws === null && slot.awayAt !== null) {
          clearTimeout(slot.reconnectTimer);
          slot.ws             = ws;
          slot.awayAt         = null;
          slot.reconnectTimer = null;
          if (userId) slot.userId = userId;
          ws._rateCount = 0;
          ws._rateReset = Date.now() + RATE_LIMIT_WINDOW;
          logger.info('Reconnect (token)', { gameId: room.gameId, playerId: pid });
          return { playerId: pid, reconnectToken: slot.reconnectToken };
        }
      }
      // Token gönderildi ama eşleşen bir "away" slot yok — bu, kopmuş bir
      // oyuncunun DEĞİL, TAZE bir katılımcının (ör. arkadaş kodunu giren
      // kişi) isteği olabilir; istemcinin localStorage'ında (aynı tarayıcı/
      // cihazda test ederken paylaşılan storage gibi durumlarda) BAŞKA bir
      // oyuncuya ait eski bir token kalmış olabilir. Böyle bir durumda
      // katılımı TAMAMEN reddetmek yerine (önceki davranış), token'ı yok
      // sayıp normal yeni-oyuncu akışına devam ediyoruz — aksi halde
      // "kodu kopyaladım ama odaya giremiyorum" sorunu ortaya çıkıyordu.
      logger.warn('Eslesmeyen reconnect token — taze katilim olarak devam ediliyor', { gameId: room.gameId });
    }

    for (const [pid, slot] of Object.entries(room.slots)) {
      if (!slot.ws && slot.name === null) {
        const token         = generateToken();
        slot.ws             = ws;
        slot.name           = name ?? pid;
        slot.userId         = userId;
        slot.reconnectToken = token;
        slot.awayAt         = null;
        return { playerId: pid, reconnectToken: token };
      }
    }
    throw new Error('Oda dolu.');
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

  // ── Yayın (instance'lar arası) ────────────────────────────
  //
  // Artık doğrudan ws.send() YOK — her şey Redis pub/sub üzerinden
  // yayınlanır ve #onRemoteRoomEvent handler'ı (TÜM instance'larda,
  // yayınlayan dahil) bunu kendi yerel soketlerine iletir.

  async #broadcast(room, state, event, rawPayload = null) {
    const payload = rawPayload ?? {
      type: 'STATE_UPDATE',
      state,
      event: event ?? null,
      nextAutoAt: room.nextAutoAt ?? null,
    };
    await publishRoomEvent(room.gameId, { kind: 'broadcast', payload });
  }

  async #notifyOther(room, senderId, payload) {
    await publishRoomEvent(room.gameId, { kind: 'toOther', senderPlayerId: senderId, payload });
  }

  #sendTo(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  /** Redis pub/sub'dan (kendi yayınımız dahil) gelen olayı yerel soketlere ilet. */
  #onRemoteRoomEvent(gameId, msg) {
    const room = this.#rooms.get(gameId);
    if (!room) return; // bu instance'ta bu odayla ilgili kimse yok
    const { kind, senderPlayerId, targetPlayerId, payload } = msg;
    const raw = JSON.stringify(payload);
    for (const [pid, slot] of Object.entries(room.slots)) {
      if (kind === 'toOther'  && pid === senderPlayerId) continue;
      if (kind === 'toPlayer' && pid !== targetPlayerId) continue;
      if (slot.ws?.readyState === 1) slot.ws.send(raw);
    }
  }

  async #closeRoom(room, reason) {
    room.status = 'finished';
    this.#clearAutoTimer(room.gameId);
    this.#clearFinishTimer(room.gameId);
    for (const slot of Object.values(room.slots)) clearTimeout(slot.reconnectTimer);

    await this.#broadcast(room, null, null, { type: 'ROOM_CLOSED', reason });
    // Yerel soketleri de doğrudan kapat (pub/sub mesajı ulaşana kadar
    // bağlantı açık kalmasın diye).
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) {
        setTimeout(() => slot.ws?.close(), 50);
      }
    }

    await deleteRoomRecord(room.gameId);
    this.#rooms.delete(room.gameId);
    logger.info('Oda kapandi', { gameId: room.gameId, reason });
  }

  /** Oda kaydını (lobi dahil) Redis'e yazar — ws/timer gibi canlı alanlar hariç. */
  async #persistRoom(room) {
    const record = {
      gameId:  room.gameId,
      private: room.private,
      status:  room.status,
      collectionReady: room.collectionReady,
      lobbyReady:      room.lobbyReady,
      rematch:         room.rematch,
      nextAutoAt:      room.nextAutoAt ?? null,
      engineState:     JSON.parse(room.engine.serialize()),
      slots: {
        player1: {
          name: room.slots.player1.name, userId: room.slots.player1.userId,
          reconnectToken: room.slots.player1.reconnectToken, awayAt: room.slots.player1.awayAt,
        },
        player2: {
          name: room.slots.player2.name, userId: room.slots.player2.userId,
          reconnectToken: room.slots.player2.reconnectToken, awayAt: room.slots.player2.awayAt,
        },
      },
    };
    await saveRoomRecord(room.gameId, record);
  }

  stats() {
    return {
      rooms:   this.#rooms.size,
      playing: [...this.#rooms.values()].filter(r => r.status === 'playing').length,
      waiting: [...this.#rooms.values()].filter(r => r.status === 'waiting').length,
    };
  }
}
