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
//
//  3 VE 4 KİŞİLİK MOD DESTEĞİ
//  ────────────────────────────────────────────────────────
//  Her oda artık bir `playerCount` (2, 3 veya 4) taşır ve buna göre
//  `GameEngine` (2 kişilik), `GameEngine3P` ya da `GameEngine4P` örneği
//  kullanır — bkz. engineClassFor/applyActionFor. Slot sayısı, hazır-
//  olma haritaları, rövanş ve persist mantığı `room.slots`'un
//  anahtarlarına göre GENEL hâle getirildi — artık hardcoded
//  'player1'/'player2' çiftine bağlı değil, playerCount 2, 3 veya 4
//  olsun fark etmez aynı kod yolundan geçer.
//
//  Bot eşleştirme sistemi YALNIZCA 2 kişilik modda çalışır (3P/4P'de
//  oda son oyuncu gelene kadar süresiz bekler — 3P Kural 54, 4P Kural 52).
// =========================================================

import { randomBytes }               from 'crypto';
import { GameEngine }                from '../game/GameEngine.js';
import { GameEngine3P }              from '../game/GameEngine3P.js';
import { GameEngine4P }              from '../game/GameEngine4P.js';
import { applyAction, ACTION_TYPES } from '../game/actions.js';
import { applyAction3P }             from '../game/actions3P.js';
import { applyAction4P }             from '../game/actions4P.js';
import { STATUS }                    from '../game/GameState.js';
import {
  saveRoomRecord, loadRoomRecord, deleteRoomRecord,
  publishRoomEvent, subscribeRoomEvents, withRoomLock,
  enqueuePublicRoom, listPublicQueue, dequeuePublicRoom,
} from '../utils/redis.js';
import { logger }  from '../utils/logger.js';
import { capture } from '../utils/monitoring.js';

const DEFAULT_RECONNECT_MS   = 20_000;
const DEFAULT_BID_TIMEOUT_MS = 10_000;

// Rate limiting: bir bağlantıdan saniyede en fazla bu kadar ACTION.
// DDoS senaryosunda RATE_LIMIT_MAX'i düşürün; arka katmanda wsServer.js
// IP bağlantı rate limit zaten filtreliyor.
const RATE_LIMIT_MAX        = 10;    // action/saniye
const RATE_LIMIT_WINDOW     = 1000;  // ms
const RATE_LIMIT_STRIKE_MAX = 5;     // N aşımda bağlantıyı kes
const RATE_LIMIT_STRIKE_TTL = 10_000; // ms içinde

// Bot eşleştirme: ikinci oyuncu bu süre içinde gelmezse bot eklenir (0=devre dışı).
// YALNIZCA 2 kişilik modda kullanılır — bkz. #createRoom ve connect().
const BOT_MATCH_DELAY_MS = Number(process.env.BOT_MATCH_DELAY_MS ?? 0);

/** Güvenli reconnect token üretir (64 hex karakter). */
function generateToken() {
  return randomBytes(32).toString('hex');
}

// İki oyuncu da "Hazırım" dedikten sonra maçın gerçekten başlamasına kadar
// geçen senkronize geri sayım süresi (istemci bu süre boyunca 5→1→GO gösterir).
const DEFAULT_LOBBY_COUNTDOWN_MS = 5_000;

// "Otomatik" faz geçişleri için sunucu-taraflı süreler.
const DEFAULT_AUTO_DELAYS = Object.freeze({
  [STATUS.ROUND_RESULT]: 3_000,
  [STATUS.COLLECTION]:   10_000,
  [STATUS.BATTLE]:       5_000,
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

/** playerCount'a göre slot ID listesi üretir. 2, 3 veya 4 desteklenir. */
function playerIdsFor(playerCount) {
  if (playerCount === 4) return ['player1', 'player2', 'player3', 'player4'];
  if (playerCount === 3) return ['player1', 'player2', 'player3'];
  return ['player1', 'player2'];
}

/**
 * playerCount'a göre doğru GameEngine sınıfını döndürür. Önceden bu seçim
 * `playerCount === 3 ? GameEngine3P : GameEngine` gibi tekrarlanan üçlü
 * ifadelerle her çağrı noktasında ayrı ayrı yazılıyordu — 4P eklerken bu
 * üçlülerin HER BİRİNİ bulup güncellemek gerekiyordu ve biri unutulursa
 * (sessizce 2 kişilik motora düşme riski) fark edilmesi zor bir hataya
 * yol açardı. Tek bir seçici fonksiyonda toplamak, ileride 5. bir mod
 * eklenirse de tek satırlık bir değişikliği yeterli kılar.
 */
function engineClassFor(playerCount) {
  if (playerCount === 4) return GameEngine4P;
  if (playerCount === 3) return GameEngine3P;
  return GameEngine;
}

/** playerCount'a göre doğru applyAction fonksiyonunu döndürür (bkz. engineClassFor). */
function applyActionFor(playerCount) {
  if (playerCount === 4) return applyAction4P;
  if (playerCount === 3) return applyAction3P;
  return applyAction;
}

/**
 * playerCount'a göre analytics event adı üretir. 2 kişilik modda geriye
 * dönük uyum için ek son ek YOKTUR (mevcut dashboard'lar/sorgular bu ismi
 * bekliyor); 3P ve 4P kendi son eklerini kullanır.
 */
function analyticsEventName(playerCount, baseName) {
  if (playerCount === 4) return `${baseName}_4p`;
  if (playerCount === 3) return `${baseName}_3p`;
  return baseName;
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
  #botTimers    = new Map(); // gameId → bot match timer (yalnızca 2 kişilik modda dolar)
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
    // 3 veya 4 kişilik mod isteği geçerli mi? wsServer.js JOIN mesajından
    // `playerCount` alanını buraya geçirmelidir; geçersiz/eksikse 2'ye düşer.
    const requestedPlayerCount = [2, 3, 4].includes(opts.playerCount) ? opts.playerCount : 2;

    let room, playerId, reconnectToken;

    if (opts.gameId) {
      // Arkadaş kodu / reconnect — kilit altında: taze veriyi çek, slot ata,
      // hemen kaydet. Böylece iki farklı instance aynı odaya aynı anda
      // yazmaya çalışsa bile çakışma olmaz. NOT: mevcut odaya katılırken
      // playerCount odanın kendi değeridir, requestedPlayerCount göz ardı edilir.
      ({ room, playerId, reconnectToken } = await withRoomLock(opts.gameId, async () => {
        const r = await this.#getOrRestoreRoom(opts.gameId);
        const a = this.#assignSlot(r, ws, opts.playerName, opts.userId, opts.reconnectToken);
        await this.#persistRoom(r);
        return { room: r, ...a };
      }));
    } else if (opts.privateLobby) {
      // Özel oda — matchmaking'e GIRME, yeni izole oda aç
      room = this.#createRoom(true, requestedPlayerCount);
      ({ playerId, reconnectToken } = await withRoomLock(room.gameId, async () => {
        const a = this.#assignSlot(room, ws, opts.playerName, opts.userId);
        await this.#persistRoom(room);
        return a;
      }));
    } else {
      // Rastgele eşleştirme — Redis destekli public queue ile multi-instance uyumlu.
      //
      // Kuyruk playerCount'a göre AYRI namespace'lenmiş durumda
      // ("waiting:public:2" / "waiting:public:3" — bkz. redis.js), bu yüzden
      // peekPublicQueue(requestedPlayerCount) döndürdüğü aday HER ZAMAN doğru
      // moddadır; WRONG_MODE senaryosu artık normal koşullarda oluşmaz (yine
      // de eski/karma bir kayıt ihtimaline karşı savunma amaçlı bırakıldı).
      //
      // ÖNEMLİ (yarış durumu düzeltmesi): "kuyruğa bak → boşsa yeni oda aç"
      // adımı ESKİDEN kilitsizdi. İki oyuncu neredeyse aynı anda rastgele
      // eşleşme istediğinde, ikisi de kuyruğu "boş" görüp AYRI odalar
      // açabiliyordu — birbirlerini asla bulamıyorlardı ("lobiye giriyor
      // ama rakip hiç eşleşmiyor" hatasının kaynağı buydu). Artık tüm
      // peek→katıl/oda-aç→kuyruğa-ekle akışı, aynı playerCount için TEK bir
      // "matchmaking:<playerCount>" kilidi altında ATOMİK yapılıyor — bu
      // sayede iki eşzamanlı istek asla birbirini kaçırmaz.
      //
      // ÖNEMLİ (ölü kayıt düzeltmesi): Eskiden kuyruktan YALNIZCA TEK bir
      // adaya bakılıyordu ve o aday Redis'te artık bulunamıyorsa
      // #getOrRestoreRoom'un fırlattığı "Oda bulunamadi" hatası STALE
      // sayılmayıp yukarı fırlatılıyordu. İki sonucu vardı:
      //   1. Oyuncu "Sunucu hatasi" alıp hiç odaya giremiyordu,
      //   2. Ölü gameId kuyruktan SİLİNMİYORDU — sonraki her istek aynı ölü
      //      kayda çarpıyor, o mod kalıcı olarak kilitleniyordu.
      // (Prod'da 3 kişilik rastgele modu bu yüzden tamamen çalışmıyordu.)
      // Artık: kuyruktaki TÜM adaylar sırayla denenir, uygun olmayan her aday
      // kuyruktan temizlenip bir sonrakine geçilir, "oda yok" durumu da
      // STALE kabul edilir.
      const matchLockKey = `matchmaking:${requestedPlayerCount}`;
      ({ room, playerId, reconnectToken } = await withRoomLock(matchLockKey, async () => {
        const candidates = await listPublicQueue(requestedPlayerCount);

        for (const candidateGameId of candidates) {
          try {
            return await withRoomLock(candidateGameId, async () => {
              let r;
              try {
                r = await this.#getOrRestoreRoom(candidateGameId);
              } catch {
                // Oda ne yerelde ne Redis'te var — kuyrukta unutulmuş ölü kayıt.
                // Temizle ve sıradaki adaya geç.
                logger.warn('Kuyrukta olu oda kaydi temizlendi', {
                  gameId: candidateGameId, playerCount: requestedPlayerCount,
                });
                await dequeuePublicRoom(candidateGameId, requestedPlayerCount);
                throw new Error('STALE');
              }

              // Oda hâlâ uygun mu? (waiting + boş slot + public)
              if (r.status !== 'waiting' || r.private) {
                await dequeuePublicRoom(candidateGameId, requestedPlayerCount);
                throw new Error('STALE');
              }
              if (r.playerCount !== requestedPlayerCount) {
                // Savunma amaçlı: normalde ayrı kuyruklar sayesinde buraya
                // düşülmez, ama eski/karma bir kayıt varsa kuyruktan temizle.
                await dequeuePublicRoom(candidateGameId, requestedPlayerCount);
                throw new Error('WRONG_MODE');
              }
              const hasVirginSlot = Object.values(r.slots).some(s => !s.ws && s.name === null);
              if (!hasVirginSlot) {
                await dequeuePublicRoom(candidateGameId, requestedPlayerCount);
                throw new Error('STALE');
              }
              const a = this.#assignSlot(r, ws, opts.playerName, opts.userId);
              // Oda tamamen doldu mu? Dolduysa kuyruktan çıkar.
              const stillHasSlot = Object.values(r.slots).some(s => s.name === null);
              if (!stillHasSlot) await dequeuePublicRoom(candidateGameId, requestedPlayerCount);
              await this.#persistRoom(r);
              return { room: r, playerId: a.playerId, reconnectToken: a.reconnectToken };
            });
          } catch (err) {
            if (err.message !== 'STALE' && err.message !== 'WRONG_MODE') throw err;
            // Bu aday uygun değil — kuyruktan temizlendi, sıradakini dene.
            continue;
          }
        }

        // Hiçbir aday uygun değil — yeni public oda aç ve kuyruğa ekle
        const newRoom = this.#createRoom(false, requestedPlayerCount);
        const a = await withRoomLock(newRoom.gameId, async () => {
          const assigned = this.#assignSlot(newRoom, ws, opts.playerName, opts.userId);
          await this.#persistRoom(newRoom);
          await enqueuePublicRoom(newRoom.gameId, requestedPlayerCount);
          return assigned;
        });
        return { room: newRoom, playerId: a.playerId, reconnectToken: a.reconnectToken };
      }));
    }

    ws._gameId   = room.gameId;
    ws._playerId = playerId;

    // Rate limiter state'i başlat
    ws._rateCount       = 0;
    ws._rateReset       = Date.now() + RATE_LIMIT_WINDOW;
    ws._rateStrikes     = 0;
    ws._rateStrikeFirst = 0;

    logger.info('Oyuncu baglandi', { gameId: room.gameId, playerId, playerCount: room.playerCount });
    this.#sendTo(ws, {
      type:           'CONNECTED',
      gameId:         room.gameId,
      playerId,
      reconnectToken,
      state:          room.engine.getState(),
      nextAutoAt:     room.nextAutoAt ?? null,
    });

    // Oyun otomatik başlamaz — tüm oyuncular lobide "Hazırım" demeli.
    if (room.status === 'waiting') {
      await this.#broadcastLobby(room);

      // Bot eşleştirme YALNIZCA 2 kişilik public odalarda çalışır.
      // 3 kişilik modda oda üçüncü oyuncu gelene kadar süresiz bekler
      // (Kural 54) — bot mekanizması hiç tetiklenmez.
      const filledCount = Object.values(room.slots).filter(s => s.name !== null).length;
      if (room.playerCount === 2 && filledCount === 1 && !room.private && BOT_MATCH_DELAY_MS > 0) {
        this.#startBotTimer(room);
      } else if (filledCount === room.playerCount) {
        this.#cancelBotTimer(room.gameId);
      }
    }
    // 'playing' durumunda reconnect: rakip(ler) hâlâ oyundaysa güncel
    // state zaten yukarıdaki CONNECTED içinde verildi, ekstra işlem gerekmez.

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
    // ── Rate limiting (ACTION başına) ──────────────────────
    // Katman 1: pencere sayacı
    const now = Date.now();
    if (now > ws._rateReset) {
      ws._rateCount = 0;
      ws._rateReset = now + RATE_LIMIT_WINDOW;
    }
    ws._rateCount = (ws._rateCount ?? 0) + 1;

    if (ws._rateCount > RATE_LIMIT_MAX) {
      // Katman 2: strike sayacı — aşımlar birikirse bağlantıyı kes
      ws._rateStrikes    = (ws._rateStrikes ?? 0) + 1;
      ws._rateStrikeFirst = ws._rateStrikeFirst ?? now;

      // Strike TTL dolmuşsa sayacı sıfırla
      if (now - ws._rateStrikeFirst > RATE_LIMIT_STRIKE_TTL) {
        ws._rateStrikes    = 1;
        ws._rateStrikeFirst = now;
      }

      this.#sendTo(ws, { type: 'ERROR', error: 'Cok fazla istek. Lutfen bekleyin.' });
      logger.warn('Rate limit asildi', {
        playerId: ws._playerId,
        gameId:   ws._gameId,
        ip:       ws._clientIp,
        strikes:  ws._rateStrikes,
      });

      // Aşırı ihlalci → bağlantıyı kes (DDoS/spam koruması)
      if (ws._rateStrikes >= RATE_LIMIT_STRIKE_MAX) {
        logger.warn('Rate limit: baglanti sonlandiriliyor', {
          playerId: ws._playerId,
          ip:       ws._clientIp,
          strikes:  ws._rateStrikes,
        });
        ws.terminate();
      }
      return;
    }
    // ────────────────────────────────────────────────────────

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

        const result = this.#applyToEngine(room, action);
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
   * Lobi: TÜM oyuncular (2, 3 veya 4, room.playerCount'a göre) "Hazırım"
   * dedikten sonra LOBBY_COUNTDOWN_MS'lik senkronize bir geri sayım başlar;
   * süre bitince sunucu maçı başlatır.
   */
  async #handleLobbyReady(room, playerId) {
    if (!room.lobbyReady) room.lobbyReady = this.#makeReadyMap(room);
    room.lobbyReady[playerId] = true;
    // Gerçek oyuncu "Hazırım" dedi — bot artık gerekmez (2p'de no-op olabilir,
    // 3p'de zaten hiç başlamamıştır).
    this.#cancelBotTimer(room.gameId);
    await this.#persistRoom(room);
    await this.#broadcastLobby(room);

    // "Herkes burada mı?" artık ws referansına değil, kalıcı slot bilgisine
    // (isim atanmış + away değil) bakılarak belirleniyor — rakip(ler) başka
    // bir instance'a bağlı olsa bile doğru sonuç verir.
    const ids = Object.keys(room.slots);
    const allPresent = ids.every((id) => slotPresent(room.slots[id]));
    const allReady   = ids.every((id) => room.lobbyReady[id]);
    if (!allPresent || !allReady) return;
    if (room.lobbyCountdownTimer) return; // zaten başlatıldı (bu instance'ta)

    const startsAt = Date.now() + this.#lobbyCountdownMs;
    await this.#broadcast(room, null, null, {
      type: 'LOBBY_COUNTDOWN_START', startsAt, durationMs: this.#lobbyCountdownMs,
    });
    logger.info('Lobi geri sayimi basladi', { gameId: room.gameId, playerCount: room.playerCount });

    room.lobbyCountdownTimer = setTimeout(async () => {
      room.lobbyCountdownTimer = null;
      try {
        await withRoomLock(room.gameId, async () => {
          const fresh = await this.#getOrRestoreRoom(room.gameId);
          if (fresh.status !== 'waiting') return; // bu arada biri ayrılmış/durum değişmiş olabilir

          fresh.status = 'playing';
          const names = {};
          Object.keys(fresh.slots).forEach((id) => {
            names[id] = fresh.slots[id].name ?? `Oyuncu ${id.slice(-1)}`;
          });
          const result = fresh.engine.startGame(names);
          this.#scheduleAuto(fresh);
          await this.#persistRoom(fresh);
          await this.#broadcast(fresh, fresh.engine.getState(), result.event);
          logger.info('Oyun basladi (lobi hazir)', { gameId: fresh.gameId, playerCount: fresh.playerCount });

          // Analytics: oyun başlangıcı
          const presence = {};
          Object.keys(fresh.slots).forEach((id) => { presence[`has_${id}`] = !!fresh.slots[id].userId; });
          capture(analyticsEventName(fresh.playerCount, 'game_started'), {
            gameId:      fresh.gameId,
            isPrivate:   fresh.private,
            playerCount: fresh.playerCount,
            ...presence,
          });
        });
      } catch (err) {
        logger.error('Lobi baslatma hatasi', { gameId: room.gameId, err: err.message });
      }
    }, this.#lobbyCountdownMs);
  }

  async #broadcastLobby(room) {
    const players = {};
    for (const [pid, slot] of Object.entries(room.slots)) {
      // ÖNEMLİ: slot.name dolu olsa bile oyuncu ayrılmış (awayAt set edilmiş)
      // olabilir — reconnect penceresi içinde slot.name/reconnectToken bilerek
      // korunuyor ki geri dönünce yerini bulsun. Ama bu yüzden burada SADECE
      // slot.name'e bakmak, kopmuş bir oyuncuyu diğerlerine hâlâ "bağlı" gibi
      // gösteriyordu — lobi sonsuza kadar "herkes hazır bekleniyor" durumunda
      // kilitleniyordu çünkü kopan oyuncu hiçbir zaman READY gönderemez.
      // slotPresent() hem ismi HEM DE awayAt==null olmasını kontrol eder.
      if (slotPresent(slot)) players[pid] = { name: slot.name };
    }
    const ready = room.lobbyReady ?? this.#makeReadyMap(room);
    await this.#broadcast(room, null, null, {
      type: 'LOBBY_UPDATE', players, ready, playerCount: room.playerCount,
    });
  }

  /**
   * Collection fazında (maç ortasında, savaş öncesi) "Hazırım".
   * TÜM oyuncular (2, 3 veya 4) hazır olunca savaş fazı başlar.
   */
  async #handleCollectionReady(room, playerId) {
    const state = room.engine.getState();
    if (state.status !== STATUS.COLLECTION) return;

    room.collectionReady[playerId] = true;
    await this.#persistRoom(room);
    await this.#broadcastReady(room);

    await this.#tryStartBattleIfAllReady(room);
  }

  /**
   * TÜM oyuncular (forfeited olanlar #makeReadyMap/#forfeit tarafından
   * zaten otomatik hazır sayılır — Kural 33) hazır olduğunda savaş fazını
   * başlatır. Hem normal "Hazırım" akışından (#handleCollectionReady) hem
   * de bir oyuncu tam da COLLECTION'da beklerken forfeit olup son eksik
   * "hazır" onu olduğunda (#forfeit) çağrılır — iki çağrı noktası da aynı
   * mantığı tekrarlamasın diye buraya çıkarıldı.
   */
  async #tryStartBattleIfAllReady(room) {
    const gameId = room.gameId;
    const state = room.engine.getState();
    if (state.status !== STATUS.COLLECTION) return;

    const allReady = Object.values(room.collectionReady).every(Boolean);
    if (!allReady) return;

    this.#clearAutoTimer(gameId);
    const result = this.#applyToEngine(room, { type: ACTION_TYPES.START_BATTLE, payload: {} });
    if (!result.ok) return; // durum bu arada değişmiş olabilir — zararsız

    const newState = room.engine.getState();
    logger.info('Herkes hazir — savas basliyor', { gameId, playerCount: room.playerCount });

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
      room.collectionReady = this.#makeReadyMap(room);
    }
  }

  async #broadcastReady(room) {
    await this.#broadcast(room, null, null, { type: 'READY_UPDATE', ready: { ...room.collectionReady } });
  }

  /**
   * room.slots'un anahtarlarına göre { player1:false, player2:false, ... }
   * hazır-olma haritası üretir.
   *
   * KURAL 33 DÜZELTMESİ (4P dokümanında "zorunlu" işaretlenmiş, 3P kodundan
   * miras bir kilitlenme riskiydi — burada da düzeltildi): forfeited
   * (ayrılmış) bir oyuncu artık asla bağlanamayacağı için READY/Hazırım
   * mesajı GÖNDEREMEZ. Bu haritayı forfeited oyuncular için de `false` ile
   * başlatmak, hazır-olma sayımının (lobi ya da collection fazı)
   * SONSUZA KADAR tamamlanamaması anlamına gelirdi — oyun kilitlenirdi.
   * Bu yüzden forfeited oyuncular haritada baştan `true` (otomatik hazır)
   * sayılır; `allReady = ids.every(id => map[id])` / `Object.values(map)
   * .every(Boolean)` kontrolleri hiçbir çağrı noktasında değişmeden doğru
   * çalışmaya devam eder, çünkü forfeited oyuncu zaten "hazır" görünür.
   *
   * NOT: Bu yalnızca haritanın YENİDEN oluşturulduğu anı (oda kuruluşu,
   * collection fazına yeni giriş) kapsar. Bir oyuncu haritanın halihazırda
   * var olduğu bir anda forfeit olursa (ör. tam da COLLECTION'da beklerken
   * bağlantısı kopup pencere dolarsa), mevcut haritayı da güncellemek
   * gerekir — bu ikinci durum #forfeit içinde ayrıca ele alınır.
   */
  #makeReadyMap(room) {
    const state = room.engine?.getState?.();
    return Object.fromEntries(
      Object.keys(room.slots).map((id) => [id, !!state?.players?.[id]?.forfeited])
    );
  }

  /**
   * Action'ı doğru motora yönlendirir (bkz. applyActionFor). ACTION_TYPES
   * sabitlerinin string değerleri üç motorda da (2P/3P/4P) birebir aynı
   * olduğundan (bkz. actions.js / actions3P.js / actions4P.js), çağıran kod
   * tek bir ACTION_TYPES setiyle yazılabilir — yalnızca apply fonksiyonu
   * playerCount'a göre değişir.
   */
  #applyToEngine(room, action) {
    return applyActionFor(room.playerCount)(room.engine, action);
  }

  // ── Bot Eşleştirme (yalnızca 2 kişilik mod) ───────────────
  //
  // Yalnız kalan bir public lobby oyuncusuna BOT_MATCH_DELAY_MS sonra
  // bir bot eklenir. Bot "Hazırım" bildirir ve oyun başlar.
  // Bot gerçek bir AI değil — sadece her turu otomatik olarak sunucu
  // kararları ile tamamlayan sahte bir oyuncu. Teklif vermez, otomatik
  // dağıtım mekanizması devreye girer (parası 0 olan oyuncu gibi davranır).
  //
  // BOT_MATCH_DELAY_MS=0 ise bot sistemi hiç çalışmaz. 3 kişilik odalarda
  // bu metotlar hiçbir zaman tetiklenmez (bkz. connect() ve #createRoom).

  #startBotTimer(room) {
    if (room.playerCount !== 2) return; // güvenlik: 3p'de asla
    if (!BOT_MATCH_DELAY_MS || this.#botTimers.has(room.gameId)) return;
    logger.info('Bot timer basladi', { gameId: room.gameId, delayMs: BOT_MATCH_DELAY_MS });
    const timer = setTimeout(() => {
      this.#addBot(room.gameId).catch((err) =>
        logger.error('Bot ekleme hatasi', { gameId: room.gameId, err: err.message })
      );
    }, BOT_MATCH_DELAY_MS);
    this.#botTimers.set(room.gameId, timer);
  }

  #cancelBotTimer(gameId) {
    const t = this.#botTimers.get(gameId);
    if (t) { clearTimeout(t); this.#botTimers.delete(gameId); }
  }

  async #addBot(gameId) {
    this.#botTimers.delete(gameId);

    await withRoomLock(gameId, async () => {
      const room = await this.#getOrRestoreRoom(gameId).catch(() => null);
      if (!room || room.status !== 'waiting') return; // oyuncu bu arada gelmiş olabilir
      if (room.playerCount !== 2) return; // güvenlik: 3p'de asla

      // Boş slot var mı?
      const emptySlot = Object.entries(room.slots).find(([, s]) => s.name === null);
      if (!emptySlot) return; // oda dolmuş

      const [botPid] = emptySlot;
      const botName  = '🤖 Bot';

      // Slotu doldur (ws=null — bot gerçek bir soket değil)
      room.slots[botPid] = {
        ws:             null,
        name:           botName,
        userId:         null,
        reconnectToken: null,
        awayAt:         null,
        reconnectTimer: null,
        isBot:          true,
      };
      room.lobbyReady[botPid] = true;

      logger.info('Bot eklendi', { gameId, botPid });
      capture('bot_matched', { gameId, botPid });

      await this.#persistRoom(room);
      await this.#broadcastLobby(room);

      // Gerçek oyuncunun "Hazırım" bildirgesi gelmiş mi? Geldiyse oyunu başlat.
      const humanPid  = botPid === 'player1' ? 'player2' : 'player1';
      const humanReady = room.lobbyReady[humanPid];

      if (humanReady) {
        // Her iki taraf hazır → lobby countdown'ı başlat
        await this.#handleBotLobbyStart(room);
      }
      // Değilse insan "Hazırım" deyince #handleLobbyReady → ikisi hazır → oyun başlar
    });
  }

  /**
   * Bot + insan her ikisi de "hazır" olduğunda lobby countdown'ı başlatır.
   * Standart #handleLobbyReady mantığını taklit eder. Yalnızca 2 kişilik mod.
   */
  async #handleBotLobbyStart(room) {
    if (room.playerCount !== 2) return; // güvenlik: 3p'de asla
    if (room.lobbyCountdownTimer) return;
    const startsAt = Date.now() + this.#lobbyCountdownMs;
    await this.#broadcast(room, null, null, {
      type: 'LOBBY_COUNTDOWN_START', startsAt, durationMs: this.#lobbyCountdownMs,
    });
    room.lobbyCountdownTimer = setTimeout(async () => {
      room.lobbyCountdownTimer = null;
      try {
        await withRoomLock(room.gameId, async () => {
          const fresh = await this.#getOrRestoreRoom(room.gameId);
          if (fresh.status !== 'waiting') return;
          fresh.status = 'playing';
          const names = {
            player1: fresh.slots.player1.name ?? 'Oyuncu 1',
            player2: fresh.slots.player2.name ?? 'Oyuncu 2',
          };
          const result = fresh.engine.startGame(names);
          this.#scheduleAuto(fresh);
          await this.#persistRoom(fresh);
          await this.#broadcast(fresh, fresh.engine.getState(), result.event);
          logger.info('Oyun basladi (bot eslesmesi)', { gameId: fresh.gameId });
          capture('game_started', { gameId: fresh.gameId, isPrivate: false, hasBot: true, playerCount: 2 });
        });
      } catch (err) {
        logger.error('Bot lobi baslatma hatasi', { gameId: room.gameId, err: err.message });
      }
    }, this.#lobbyCountdownMs);
  }

  // ── Otomatik faz ilerletme (sunucu-taraflı, istemciden bağımsız) ──

  /**
   * Restart / yeni instance restore sonrası mevcut oyun fazı için timer'ı
   * yeniden kurar. `delay` ms sonra #scheduleAuto'yu çağırır; #scheduleAuto
   * state'e bakarak doğru action'ı belirler.
   *
   * Neden doğrudan #scheduleAuto değil? Çünkü #scheduleAuto `nextAutoAt`'ı
   * SIFIRDAN hesaplar — ama restore edilen oda için "ne zaman tetiklenecekti"
   * bilgisi Redis'ten geliyor. Bu metod, kalan süreyi hesaplayarak sadece
   * doğru gecikmeyle yeniden schedule eder.
   */
  #rescheduleAutoFromRecord(room, delay) {
    if (this.#autoTimers.has(room.gameId)) return; // zaten planlanmış
    const state = room.engine.getState();

    // AUCTION fazı: aktif teklif sahibi belirlenerek bid timeout kurulur.
    if (state.status === STATUS.AUCTION) {
      const activeBidderId = state.auction?.activeBidderId;
      if (!activeBidderId) return;
      const timer = setTimeout(() => {
        this.#autoPassAuction(room.gameId, activeBidderId).catch((err) => {
          logger.error('Restore bid timeout hatasi', { gameId: room.gameId, err: err.message });
        });
      }, delay);
      this.#autoTimers.set(room.gameId, timer);
      logger.info('Bid timeout restore edildi', { gameId: room.gameId, delay, activeBidderId });
      return;
    }

    // Diğer fazlar: mevcut state'e göre actionType belirle
    let actionType;
    if (state.status === STATUS.BATTLE && state.battle?.revealed) {
      actionType = ACTION_TYPES.NEXT_BATTLE;
    } else {
      actionType = {
        [STATUS.ROUND_RESULT]: ACTION_TYPES.ADVANCE_ROUND,
        [STATUS.COLLECTION]:   ACTION_TYPES.START_BATTLE,
        [STATUS.BATTLE]:       ACTION_TYPES.REVEAL_BATTLE,
      }[state.status];
    }
    if (!actionType) return;

    const timer = setTimeout(() => {
      this.#autoAdvance(room.gameId, actionType).catch((err) => {
        logger.error('Restore otomatik ilerletme hatasi', { gameId: room.gameId, err: err.message });
      });
    }, delay);
    this.#autoTimers.set(room.gameId, timer);
    logger.info('Otomatik timer restore edildi', { gameId: room.gameId, delay, actionType, status: state.status });
  }

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

      const result = this.#applyToEngine(room, { type: actionType, payload: {} });
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

      const result = this.#applyToEngine(room, {
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

  /**
   * Zaten bir withRoomLock kilidi içindeyken (ör. #forfeit içinden) bir
   * oyuncuyu zorla pas geçirtmek için kullanılır. #autoPassAuction'ın
   * aksine YENİDEN kilit almaz — nested lock deadlock riskini önler.
   */
  async #forcePassInsideLock(room, playerId) {
    const result = this.#applyToEngine(room, { type: ACTION_TYPES.PASS, payload: { passerId: playerId } });
    if (!result.ok) return;

    const newState = room.engine.getState();
    this.#syncCollectionReady(room, newState);

    if (newState.status === STATUS.FINAL) {
      this.#clearAutoTimer(room.gameId);
      this.#enterFinished(room);
    } else {
      this.#scheduleAuto(room);
    }
    await this.#persistRoom(room);
    await this.#broadcast(room, newState, result.event);
  }

  // ── Rövanş ─────────────────────────────────────────────

  #enterFinished(room) {
    // Idempotency guard — aynı oda iki farklı kod yolundan (ör. autoAdvance +
    // handleAction yarışı) ya da çoklu instance'tan finalize edilmeye
    // çalışılırsa stats iki kere yazılmasın.
    if (room.status === 'finished') return;

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
   * Maç bitince sunucu tarafında Supabase'e istatistik yazar. Güvenli:
   * client'a güvenmez, kendi hesaplar. 3/4 kişilik odalar sırasıyla
   * #saveMatchStats3P / #saveMatchStats4P'ye yönlendirilir (ayrı tablo,
   * ayrı ödül şeması — bkz. o metotların yorumu).
   */
  async #saveMatchStats(room) {
    if (room.playerCount === 4) return this.#saveMatchStats4P(room);
    if (room.playerCount === 3) return this.#saveMatchStats3P(room);

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
          winner_id:      winnerId === 'player1' ? p1Slot.userId : winnerId === 'player2' ? p2Slot.userId : null,
          p1_score:       s1,
          p2_score:       s2,
          p1_mmr_change:  p1MmrChange,
          p2_mmr_change:  p2MmrChange,
        }),
      });
    }

    logger.info('Match stats kaydedildi', { gameId: room.gameId, winnerId, p1MmrChange, p2MmrChange });

    // Analytics: oyun bitişi
    capture('game_finished', {
      gameId:       room.gameId,
      winnerId,
      p1Score:      s1,
      p2Score:      s2,
      p1MmrChange,
      p2MmrChange,
      totalRounds:  state.totalRounds,
      isPrivate:    room.private,
    });
  }

  /**
   * 3 kişilik mod istatistik kaydı — ayrı tablo (match_history_3p),
   * final sıralamasına (Kural 47-51) dayalı basit XP ödülü.
   *
   * NOT: 3 kişilik mod için MMR (ELO) formülü henüz tanımlanmadı — bu
   * sürümde mmr_change hesaplanmaz, yalnızca XP ve wins/losses güncellenir
   * (1. sıradaki "win", 2. ve 3. sıradaki "loss" sayılır — basit bir
   * varsayımdır, istersen sonra 3'lü bir ELO varyantına genişletilebilir).
   */
  async #saveMatchStats3P(room) {
    const SUPABASE_URL         = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      logger.warn('Supabase env eksik — 3p stats kaydedilmiyor');
      return;
    }

    const state   = room.engine.getState();
    const ranking = room.engine.getFinalRanking(); // [1., 2., 3. sıradaki playerId]
    const scores  = state.battle?.scores ?? {};

    const slots = { player1: room.slots.player1, player2: room.slots.player2, player3: room.slots.player3 };
    const anyUser = Object.values(slots).some((s) => s?.userId);
    if (!anyUser) return;

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

    const profiles = {};
    for (const pid of Object.keys(slots)) {
      profiles[pid] = await fetchProfile(slots[pid]?.userId);
    }

    const XP_BY_RANK = { 0: 100, 1: 60, 2: 30 };

    const updates = ranking.map((pid, idx) => {
      const profile = profiles[pid];
      if (!slots[pid]?.userId || !profile) return null;
      const xp     = (profile.xp ?? 0)     + XP_BY_RANK[idx];
      const wins   = (profile.wins ?? 0)   + (idx === 0 ? 1 : 0);
      const losses = (profile.losses ?? 0) + (idx === 0 ? 0 : 1);
      const level  = Math.max(1, Math.floor(xp / 500) + 1);
      return fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${slots[pid].userId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ xp, wins, losses, level }),
      });
    }).filter(Boolean);

    await Promise.all(updates);

    if (anyUser) {
      await fetch(`${SUPABASE_URL}/rest/v1/match_history_3p`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          room_id:           room.gameId,
          player1_id:        slots.player1?.userId ?? null,
          player2_id:        slots.player2?.userId ?? null,
          player3_id:        slots.player3?.userId ?? null,
          rank1_player_id:   slots[ranking[0]]?.userId ?? null,
          rank2_player_id:   slots[ranking[1]]?.userId ?? null,
          rank3_player_id:   slots[ranking[2]]?.userId ?? null,
          p1_score:          scores.player1 ?? 0,
          p2_score:          scores.player2 ?? 0,
          p3_score:          scores.player3 ?? 0,
          match_ended_early: !!state.matchEndedEarly,
        }),
      });
    }

    logger.info('3P Match stats kaydedildi', { gameId: room.gameId, ranking, matchEndedEarly: state.matchEndedEarly });

    capture('game_finished_3p', {
      gameId:          room.gameId,
      ranking,
      p1Score:         scores.player1 ?? 0,
      p2Score:         scores.player2 ?? 0,
      p3Score:         scores.player3 ?? 0,
      matchEndedEarly: !!state.matchEndedEarly,
      isPrivate:       room.private,
    });
  }

  /**
   * 4 kişilik mod istatistik kaydı — ayrı tablo (match_history_4p),
   * final sıralamasına (Kural 47-51) dayalı XP ödülü (Kural 50).
   *
   * NOT: 3P'de olduğu gibi 4P için de MMR (ELO) formülü henüz
   * tanımlanmadı — bu sürümde mmr_change hesaplanmaz, yalnızca XP ve
   * wins/losses güncellenir (Kural 51: yalnızca 1. sıradaki "win",
   * diğer 3'ü "loss" sayılır — basit bir varsayımdır, istersen sonra
   * "top-2 win" gibi bir modele genişletilebilir).
   *
   * match_history_4p tablosu henüz migration dosyasında tanımlı değil —
   * bu metodun çalışması için önce Supabase'e eklenmesi gerekir (bkz.
   * sohbette paylaşılan CREATE TABLE SQL'i).
   */
  async #saveMatchStats4P(room) {
    const SUPABASE_URL         = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      logger.warn('Supabase env eksik — 4p stats kaydedilmiyor');
      return;
    }

    const state   = room.engine.getState();
    const ranking = room.engine.getFinalRanking(); // [1., 2., 3., 4. sıradaki playerId]
    const scores  = state.battle?.scores ?? {};

    const slots = {
      player1: room.slots.player1, player2: room.slots.player2,
      player3: room.slots.player3, player4: room.slots.player4,
    };
    const anyUser = Object.values(slots).some((s) => s?.userId);
    if (!anyUser) return;

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

    const profiles = {};
    for (const pid of Object.keys(slots)) {
      profiles[pid] = await fetchProfile(slots[pid]?.userId);
    }

    const XP_BY_RANK = { 0: 100, 1: 70, 2: 40, 3: 20 }; // Kural 50

    const updates = ranking.map((pid, idx) => {
      const profile = profiles[pid];
      if (!slots[pid]?.userId || !profile) return null;
      const xp     = (profile.xp ?? 0)     + XP_BY_RANK[idx];
      const wins   = (profile.wins ?? 0)   + (idx === 0 ? 1 : 0); // Kural 51
      const losses = (profile.losses ?? 0) + (idx === 0 ? 0 : 1);
      const level  = Math.max(1, Math.floor(xp / 500) + 1);
      return fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${slots[pid].userId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ xp, wins, losses, level }),
      });
    }).filter(Boolean);

    await Promise.all(updates);

    if (anyUser) {
      await fetch(`${SUPABASE_URL}/rest/v1/match_history_4p`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          room_id:           room.gameId,
          player1_id:        slots.player1?.userId ?? null,
          player2_id:        slots.player2?.userId ?? null,
          player3_id:        slots.player3?.userId ?? null,
          player4_id:        slots.player4?.userId ?? null,
          rank1_player_id:   slots[ranking[0]]?.userId ?? null,
          rank2_player_id:   slots[ranking[1]]?.userId ?? null,
          rank3_player_id:   slots[ranking[2]]?.userId ?? null,
          rank4_player_id:   slots[ranking[3]]?.userId ?? null,
          p1_score:          scores.player1 ?? 0,
          p2_score:          scores.player2 ?? 0,
          p3_score:          scores.player3 ?? 0,
          p4_score:          scores.player4 ?? 0,
          match_ended_early: !!state.matchEndedEarly,
        }),
      });
    }

    logger.info('4P Match stats kaydedildi', { gameId: room.gameId, ranking, matchEndedEarly: state.matchEndedEarly });

    capture('game_finished_4p', {
      gameId:          room.gameId,
      ranking,
      p1Score:         scores.player1 ?? 0,
      p2Score:         scores.player2 ?? 0,
      p3Score:         scores.player3 ?? 0,
      p4Score:         scores.player4 ?? 0,
      matchEndedEarly: !!state.matchEndedEarly,
      isPrivate:       room.private,
    });
  }

  #clearFinishTimer(gameId) {
    const timer = this.#finishTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.#finishTimers.delete(gameId);
    }
  }

  /** Bir oyuncu rövanş ister — diğer(ler)ine bildirilir. */
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

  /**
   * İstek alan oyuncu(lar) kabul eder ya da reddeder.
   *
   * NOT (3 kişilik mod): Kural 56 "üç oyuncunun da kabul etmesi gerekir"
   * diyor, ama mevcut protokol REMATCH_RESPONSE mesajını tek bir "diğer
   * taraf" beklentisiyle tasarlanmış (requestedBy hariç herkese bildirim
   * gönderiliyor, ama kabul/red tek bir yanıt olarak işleniyor). 3 kişilik
   * odada üçüncü oyuncunun onayını ayrıca beklemek istersen wsServer.js/
   * client protokolünde REMATCH_RESPONSE'u "kaç kişi kabul etti" sayacına
   * genişletmen gerekir — bu dosyadaki mevcut hâliyle, kabul eden İLK
   * yanıt rövanşı başlatır (2 kişilik moddaki davranışla aynı). Üç kişiden
   * ikisinin onayı yeterli olmasın istiyorsan bu metodu genişletmen lazım;
   * şimdilik playerCount ne olursa olsun aynı basit akış çalışır.
   */
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
      const names = {};
      Object.keys(room.slots).forEach((id) => {
        names[id] = room.slots[id].name ?? `Oyuncu ${id.slice(-1)}`;
      });

      room.status          = 'playing';
      room.rematch         = { requestedBy: null };
      // ÖNEMLİ SIRALAMA: engine ÖNCE sıfırlanmalı, collectionReady SONRA
      // hesaplanmalı. #makeReadyMap artık (Kural 33) room.engine.getState()
      // üzerinden forfeited durumuna bakıyor — sıra ters olsaydı, ESKİ
      // (bitmiş) maçta forfeited olan bir oyuncu, henüz sıfırlanmamış eski
      // motordan okunan forfeited=true bayrağı yüzünden YENİ maçın hazır-
      // olma haritasına yanlışlıkla "otomatik hazır" olarak taşınırdı —
      // oysa taze motorda (makeInitialState) herkes forfeited:false başlar.
      room.engine          = new (engineClassFor(room.playerCount))();
      room.collectionReady = this.#makeReadyMap(room);
      const result = room.engine.startGame(names);
      this.#scheduleAuto(room);

      logger.info('Rovans kabul edildi — yeni oyun basladi', { gameId, playerCount: room.playerCount });
      await this.#persistRoom(room);
      await this.#broadcast(room, room.engine.getState(), result.event);
    });
  }

  /** Maç bitiş ekranından "Ana Menüye Dön" — diğer(ler)ine bildirilir, oda kapanır. */
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

  // ── Forfeit: kopan oyuncu kaybeder (2p) / ayrılmış sayılır (3p/4p) ────
  //
  // 2 kişilik modda forfeit = maç anında biter (tek rakip zaten galip).
  // 3/4 kişilik modda forfeit = GameEngine3P/4P.markForfeited() çağrılır;
  // oyun Kural 39 gereği kalan oyuncularla DEVAM EDER, yalnızca ayrılmamış
  // oyuncu sayısı 1'e düşerse (Kural 14) maç biter.
  async #forfeit(room, disconnectedPlayerId) {
    await withRoomLock(room.gameId, async () => {
      const fresh = await this.#getOrRestoreRoom(room.gameId).catch(() => null);
      if (!fresh || fresh.status !== 'playing') return;
      // Bu arada geri bağlanmış olabilir — hâlâ away mi kontrol et.
      if (fresh.slots[disconnectedPlayerId]?.awayAt == null) return;

      if (fresh.playerCount >= 3) {
        const result = fresh.engine.markForfeited(disconnectedPlayerId);
        if (!result.ok) return; // zaten ayrılmış vs.

        const newState = fresh.engine.getState();
        logger.info(fresh.playerCount === 4 ? '4P Forfeit' : '3P Forfeit', {
          gameId: fresh.gameId, playerId: disconnectedPlayerId,
          matchEndedEarly: !!result.event.matchEndedEarly,
          freeChoiceAutoResolved: !!result.event.freeChoiceAutoResolved,
        });

        // KURAL 33 DÜZELTMESİ — forfeit anında lobi/collection hazır-olma
        // haritaları ZATEN oluşturulmuş olabilir (ör. oyuncu tam da
        // COLLECTION fazında beklerken bağlantısı koptu ve reconnect
        // penceresi doldu). #makeReadyMap yalnızca haritanın YENİDEN
        // kurulduğu anı (oda kuruluşu / COLLECTION'a yeni giriş) kapsar;
        // burada var olan haritayı da güncelleyip forfeited oyuncuyu
        // "hazır" işaretlememiz gerekir — aksi hâlde onun READY mesajını
        // sonsuza kadar bekleyip kilitlenir.
        if (fresh.collectionReady && disconnectedPlayerId in fresh.collectionReady) {
          fresh.collectionReady[disconnectedPlayerId] = true;
        }
        if (fresh.lobbyReady && disconnectedPlayerId in fresh.lobbyReady) {
          fresh.lobbyReady[disconnectedPlayerId] = true;
        }

        if (result.event.matchEndedEarly || newState.status === STATUS.FINAL) {
          // Kural 14 — ayrılmamış oyuncu sayısı 1'e düştü, maç bitti.
          this.#clearAutoTimer(fresh.gameId);
          this.#enterFinished(fresh);
          await this.#persistRoom(fresh);
          await this.#broadcast(fresh, newState, result.event);
          return;
        }

        await this.#persistRoom(fresh);
        await this.#broadcast(fresh, newState, result.event);

        // Oyun devam ediyor (Kural 39). Üç ayrı devam senaryosu:
        //
        // 1) Kural 37-B — FREE_CHOICE decider'ı forfeit oldu ve engine
        //    otomatik olarak ROUND_RESULT'a çözdü. Bu geçiş normal bir
        //    action'dan (handleAction) DEĞİL buradan geldiği için, o yolun
        //    her zaman yaptığı #scheduleAuto çağrısı EKSİKTİ — eklenmezse
        //    ROUND_RESULT ekranı hiç otomatik ilerlemez, oyun burada
        //    kilitlenirdi (Kural 37-B'nin engine tarafındaki çözümü tek
        //    başına yeterli değildi, sunucu tarafında da tamamlanması
        //    gerekiyordu).
        if (result.event.freeChoiceAutoResolved) {
          this.#scheduleAuto(fresh);
        }

        // 2) Emniyet: forfeit anında tam da sırası gelen (activeBidderId)
        //    kişi ayrılan oyuncuysa — normalde bid-timeout reconnect
        //    penceresinden önce zaten devreye girip sırayı ilerletmiş
        //    olur, ama garanti olsun diye burada da kontrol ediyoruz
        //    (nested lock'a girmeden).
        if (newState.status === STATUS.AUCTION && newState.auction?.activeBidderId === disconnectedPlayerId) {
          await this.#forcePassInsideLock(fresh, disconnectedPlayerId);
        }

        // 3) Kural 33 — forfeit, tam da COLLECTION fazında beklerken
        //    oldu ve bu oyuncu son eksik "hazır" oyuysa, savaş fazını
        //    şimdi başlat (aksi hâlde kalanlar onun asla gönderemeyeceği
        //    bir READY'yi beklemeye devam ederdi).
        if (newState.status === STATUS.COLLECTION) {
          await this.#tryStartBattleIfAllReady(fresh);
        }
        return;
      }

      // ── 2 kişilik mevcut davranış (değişmedi) ──
      const otherIds = Object.keys(fresh.slots).filter((id) => id !== disconnectedPlayerId);
      const winnerId = otherIds[0];
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

  /**
   * @param {boolean} isPrivate
   * @param {2|3|4} playerCount — varsayılan 2 (geriye dönük uyum)
   */
  #createRoom(isPrivate = false, playerCount = 2) {
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const ids    = playerIdsFor(playerCount);

    const slots = {};
    ids.forEach((id) => {
      slots[id] = { ws: null, name: null, awayAt: null, reconnectTimer: null, userId: null, reconnectToken: null };
    });

    const room = {
      gameId,
      private: isPrivate,
      playerCount,
      status: 'waiting',
      engine: new (engineClassFor(playerCount))(),
      collectionReady: Object.fromEntries(ids.map((id) => [id, false])),
      lobbyReady:      Object.fromEntries(ids.map((id) => [id, false])),
      lobbyCountdownTimer: null,
      nextAutoAt: null,
      rematch: { requestedBy: null },
      slots,
    };
    this.#rooms.set(gameId, room);
    logger.info('Oda olusturuldu', { gameId, private: isPrivate, playerCount });
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
      const playerCount = [3, 4].includes(record.playerCount) ? record.playerCount : 2; // geriye dönük uyum: eski kayıtlarda alan yok → 2
      const EngineClass = engineClassFor(playerCount);
      const ids   = Object.keys(record.slots);
      const slots = {};
      ids.forEach((pid) => { slots[pid] = { ws: null, reconnectTimer: null, ...record.slots[pid] }; });

      const room = {
        gameId,
        private: !!record.private,
        playerCount,
        status:  record.status,
        engine:  record.engineState ? EngineClass.fromState(record.engineState) : new EngineClass(),
        collectionReady: record.collectionReady ?? Object.fromEntries(ids.map((id) => [id, false])),
        lobbyReady:      record.lobbyReady ?? Object.fromEntries(ids.map((id) => [id, false])),
        lobbyCountdownTimer: null,
        nextAutoAt: record.nextAutoAt ?? null,
        rematch: record.rematch ?? { requestedBy: null },
        slots,
      };
      this.#rooms.set(gameId, room);

      // ── Restart sonrası timer recovery ─────────────────────────────────
      // Sunucu yeniden başlatıldığında ya da bu oda başka bir instance'tan
      // ilk kez bu instance'a restore edildiğinde, oyun playing durumundaysa
      // ve nextAutoAt geçmişte (veya çok yakında) kalmışsa timer yeniden
      // başlatılır. Aksi hâlde oyuncular sonsuz "round_result" / "collection"
      // bekleme ekranında kalırdı.
      if (room.status === 'playing' && room.nextAutoAt) {
        const remaining = room.nextAutoAt - Date.now();
        // Zaten geçtiyse veya 500ms'den az kaldıysa hemen tetikle;
        // aksi hâlde kalan süre kadar bekle.
        const delay = Math.max(remaining, 500);
        this.#rescheduleAutoFromRecord(room, delay);
      }

      return room;
    }

    if (record) {
      // Yerelde var — Redis'teki daha taze paylaşılan alanları uygula,
      // ama CANLI (bu instance'a özgü) alanlara dokunma.
      local.private         = !!record.private;
      local.status          = record.status;
      local.playerCount     = [3, 4].includes(record.playerCount) ? record.playerCount : (local.playerCount ?? 2); // geriye dönük uyum
      local.collectionReady = record.collectionReady ?? local.collectionReady;
      local.lobbyReady      = record.lobbyReady ?? local.lobbyReady;
      local.rematch         = record.rematch ?? local.rematch;
      if (record.engineState) {
        local.engine = engineClassFor(local.playerCount).fromState(record.engineState);
      }
      for (const pid of Object.keys(record.slots)) {
        const r = record.slots[pid];
        if (!r) continue;
        if (!local.slots[pid]) local.slots[pid] = { ws: null, reconnectTimer: null };
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
   * Slot atar veya token ile reconnect yapar. room.slots'un anahtarlarına
   * göre çalışır — 2, 3 veya 4 kişilik odada aynı kod yolu geçerlidir.
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
    this.#cancelBotTimer(room.gameId);
    for (const slot of Object.values(room.slots)) clearTimeout(slot.reconnectTimer);

    // Public waiting kuyruğundan da temizle (oda waiting aşamasındayken
    // kapanıyorsa — ör. oyuncu reconnect süresi dolduktan sonra).
    if (!room.private) await dequeuePublicRoom(room.gameId, room.playerCount).catch(() => {});

    await this.#broadcast(room, null, null, { type: 'ROOM_CLOSED', reason });

    // Pub/sub mesajlarının (setImmediate tabanlı in-memory bus dahil) yerel
    // soketlere iletilmesini bekle; ardından odayı Map'ten sil.
    // Bu olmadan #onRemoteRoomEvent oda silimdikten SONRA çalışırsa mesaj
    // drop edilir (ör. GAME_OVER_FORFEIT + ROOM_CLOSED çifti).
    await new Promise((r) => setImmediate(r));

    // Yerel soketleri kapat
    for (const slot of Object.values(room.slots)) {
      if (slot.ws?.readyState === 1) {
        setTimeout(() => slot.ws?.close(), 50);
      }
    }

    await deleteRoomRecord(room.gameId);
    this.#rooms.delete(room.gameId);
    logger.info('Oda kapandi', { gameId: room.gameId, reason });
  }

  /**
   * Oda kaydını (lobi dahil) Redis'e yazar — ws/timer gibi canlı alanlar
   * hariç. `room.slots`'un anahtarlarına göre GENEL çalışır (2, 3 veya 4).
   */
  async #persistRoom(room) {
    const slotsRecord = {};
    for (const [pid, slot] of Object.entries(room.slots)) {
      slotsRecord[pid] = {
        name: slot.name, userId: slot.userId,
        reconnectToken: slot.reconnectToken, awayAt: slot.awayAt,
      };
    }

    const record = {
      gameId:  room.gameId,
      private: room.private,
      playerCount: room.playerCount,
      status:  room.status,
      collectionReady: room.collectionReady,
      lobbyReady:      room.lobbyReady,
      rematch:         room.rematch,
      nextAutoAt:      room.nextAutoAt ?? null,
      engineState:     JSON.parse(room.engine.serialize()),
      slots: slotsRecord,
    };
    await saveRoomRecord(room.gameId, record);
  }

  stats() {
    const rooms = [...this.#rooms.values()];
    return {
      rooms:   rooms.length,
      playing: rooms.filter(r => r.status === 'playing').length,
      waiting: rooms.filter(r => r.status === 'waiting').length,
      playing2p: rooms.filter(r => r.status === 'playing' && r.playerCount === 2).length,
      playing3p: rooms.filter(r => r.status === 'playing' && r.playerCount === 3).length,
      playing4p: rooms.filter(r => r.status === 'playing' && r.playerCount === 4).length,
    };
  }
}
