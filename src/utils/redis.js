// =========================================================
//  Redis Client — Upstash uyumlu
//
//  Upstash Redis, standart Redis protokolünü destekler.
//  ioredis ile doğrudan çalışır — Upstash SDK gerekmez.
//
//  Ortam değişkenleri:
//    REDIS_URL  = rediss://default:TOKEN@HOST:PORT
//                 (Upstash → Connect → Node.js → ioredis)
//
//  Yerel geliştirme: REDIS_URL yoksa in-memory stub kullanılır.
//  Stub production'da kullanılamaz — oyun state persist olmaz VE
//  instance'lar arası paylaşım olmaz (tek process varsayılır).
//
//  ─────────────────────────────────────────────────────────
//  NEDEN BU DOSYA GENİŞLETİLDİ?
//
//  Önceden sadece "oyun BAŞLADIKTAN sonraki" engine state'i
//  Redis'e yazılıyordu. Lobi (waiting) aşaması sadece o an
//  isteği karşılayan Node process'inin RAM'inde yaşıyordu.
//
//  Railway (ya da başka bir PaaS) birden fazla instance/replika
//  çalıştırdığında, arkadaş kodu ile katılan ya da düello daveti
//  kabul eden ikinci oyuncu FARKLI bir instance'a düşebiliyor —
//  o instance'ın belleğinde oda hiç yok, "Oda bulunamadi" hatası
//  alınıyor ve iki taraf hiçbir zaman aynı odada buluşamıyordu.
//
//  Çözüm: (1) oda kaydı artık lobi aşamasından itibaren Redis'e
//  yazılıyor, (2) instance'lar arası bir pub/sub kanalı ile
//  state güncellemeleri TÜM instance'lara yayılıyor, böylece her
//  instance kendi yerel soketlerine iletebiliyor, (3) aynı odaya
//  aynı anda iki farklı instance'ın yazmasını engellemek için
//  basit bir dağıtık kilit eklendi.
// =========================================================

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from './logger.js';

// ─── In-Memory Stub (geliştirme ortamı — tek process) ────

class MemoryRedis {
  #store    = new Map();
  #sets     = new Map(); // Redis Set taklidi (sadd/srem/smembers için)

  async get(key)  { return this.#store.get(key) ?? null; }
  async set(key, val, ...args) {
    this.#store.set(key, val);
    return 'OK';
  }
  async del(key)  { this.#store.delete(key); this.#sets.delete(key); return 1; }
  async exists(key) { return (this.#store.has(key) || this.#sets.has(key)) ? 1 : 0; }
  async quit()    { return 'OK'; }

  // Redis Set komutları — public waiting room queue için
  async sadd(key, ...members) {
    if (!this.#sets.has(key)) this.#sets.set(key, new Set());
    let added = 0;
    for (const m of members) { if (!this.#sets.get(key).has(m)) { this.#sets.get(key).add(m); added++; } }
    return added;
  }
  async srem(key, ...members) {
    if (!this.#sets.has(key)) return 0;
    let removed = 0;
    for (const m of members) { if (this.#sets.get(key).delete(m)) removed++; }
    if (this.#sets.get(key).size === 0) this.#sets.delete(key);
    return removed;
  }
  async smembers(key) {
    return [...(this.#sets.get(key) ?? [])];
  }

  // Basit NX+PX taklidi — tek process içinde yeterli (gerçek eşzamanlılık yok).
  async setNx(key, val, ttlMs) {
    const existing = this.#store.get(key);
    if (existing && existing.exp > Date.now()) return null;
    this.#store.set(key, { val, exp: Date.now() + ttlMs });
    return 'OK';
  }
  async delIfMatch(key, val) {
    const existing = this.#store.get(key);
    if (existing && existing.val === val) { this.#store.delete(key); return 1; }
    return 0;
  }
}

// Tek process içi pub/sub — MemoryRedis kullanılırken (REDIS_URL yoksa)
// gerçek ağ üzerinden değil, doğrudan EventEmitter ile dağıtılır.
const localBus = new EventEmitter();
localBus.setMaxListeners(0);

// ─── Gerçek Redis (Upstash / yerel) ──────────────────────

let _client    = null;  // komutlar için (GET/SET/DEL...)
let _subClient = null;  // sadece subscribe için ayrı bağlantı gerekir
let _usingStub = false;

const INSTANCE_ID = randomUUID();

async function getRedis() {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('REDIS_URL yok — in-memory stub kullanılıyor (tek instance varsayılır, production için uygun değil)');
    _usingStub = true;
    _client = new MemoryRedis();
    return _client;
  }

  const { default: Redis } = await import('ioredis');
  _client = new Redis(url, {
    tls: url.startsWith('rediss://') ? {} : undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  _client.on('error', (err) => logger.error('Redis bağlantı hatası', { err: err.message }));
  await _client.connect?.();
  logger.info('Redis bağlandı');
  return _client;
}

/** Sadece subscribe için kullanılan ayrı bağlantı (ioredis kısıtlaması). */
async function getRedisSub() {
  if (_subClient) return _subClient;
  const base = await getRedis();
  if (_usingStub) {
    _subClient = base; // stub'da ayrı bağlantıya gerek yok
    return _subClient;
  }
  _subClient = base.duplicate();
  _subClient.on('error', (err) => logger.error('Redis sub bağlantı hatası', { err: err.message }));
  return _subClient;
}

export { INSTANCE_ID };

// ─── Oda Kaydı (lobi + oyun state'i tek yerde) ───────────
//
// Artık sadece GameEngine state'i değil, TÜM oda (slots, status,
// private, lobbyReady, collectionReady, rematch) burada tutulur —
// böylece hangi instance sorgularsa sorgulasın odayı görebilir.

const ROOM_KEY   = (gameId) => `room:${gameId}`;
const TTL_ACTIVE = 60 * 60 * 6; // 6 saat — oynanan/lobide bekleyen odalar
const TTL_DONE   = 60 * 10;     // 10 dk  — biten odalar (rövanş penceresi için)

export async function saveRoomRecord(gameId, record) {
  const redis = await getRedis();
  const ttl = record.status === 'finished' ? TTL_DONE : TTL_ACTIVE;
  await redis.set(ROOM_KEY(gameId), JSON.stringify(record), 'EX', ttl);
}

export async function loadRoomRecord(gameId) {
  const redis = await getRedis();
  const raw = await redis.get(ROOM_KEY(gameId));
  if (!raw) return null;
  // MemoryRedis.get bazen setNx ile yazılmış {val,exp} objesi döndürebilir —
  // oda kayıtları için her zaman normal set() kullanıldığından bu string'dir.
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

export async function deleteRoomRecord(gameId) {
  const redis = await getRedis();
  await redis.del(ROOM_KEY(gameId));
}

// Geriye dönük uyumluluk (başka yerde kullanan olursa diye bırakıldı).
export async function saveGameState(gameId, state) {
  const existing = await loadRoomRecord(gameId);
  await saveRoomRecord(gameId, { ...(existing ?? {}), gameId, engineState: state });
}
export async function loadGameState(gameId) {
  const rec = await loadRoomRecord(gameId);
  return rec?.engineState ?? null;
}
export async function deleteGameState(gameId) {
  await deleteRoomRecord(gameId);
}

// ─── Instance'lar Arası Pub/Sub ───────────────────────────
//
// Bir instance bir odada bir şey değiştirdiğinde bunu bu kanaldan
// yayınlar. HER instance (yayınlayan dahil) bunu dinler ve KENDİ
// yerel soketlerine (varsa) iletir. Böylece iki oyuncu farklı
// instance'larda olsa bile ikisi de güncellemeleri görür.

const CHANNEL = 'vm:room-events';
let _subscribed = false;
const roomEventHandlers = new Set();

export async function publishRoomEvent(gameId, message) {
  const payload = JSON.stringify({ gameId, message, from: INSTANCE_ID });
  await getRedis(); // _usingStub'ı kesinleştir
  if (_usingStub) {
    // Tek process — doğrudan yerel bus üzerinden dağıt.
    setImmediate(() => localBus.emit(CHANNEL, payload));
    return;
  }
  const redis = await getRedis();
  await redis.publish(CHANNEL, payload);
}

/** Oda olaylarına abone ol. handler(gameId, message) şeklinde çağrılır. */
export async function subscribeRoomEvents(handler) {
  roomEventHandlers.add(handler);
  if (_subscribed) return;
  _subscribed = true;

  const dispatch = (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const fn of roomEventHandlers) {
      try { fn(parsed.gameId, parsed.message, parsed.from); }
      catch (err) { logger.error('room-event handler hatasi', { err: err.message }); }
    }
  };

  await getRedis(); // _usingStub'ı kesinleştir
  if (_usingStub) {
    localBus.on(CHANNEL, dispatch);
    return;
  }

  const sub = await getRedisSub();
  sub.on('message', (channel, raw) => { if (channel === CHANNEL) dispatch(raw); });
  await sub.subscribe(CHANNEL);
  logger.info('Redis pub/sub kanalina abone olundu', { channel: CHANNEL });
}

// ─── Public Waiting Room Queue (multi-instance matchmaking) ──────────────────
//
// Rastgele eşleştirme (quick match), her instance sadece kendi RAM'ini
// taradığı için çoklu instance ortamında çalışmıyordu: iki oyuncu farklı
// instance'lara düşünce her biri ayrı bir oda oluşturuyordu ve hiçbir zaman
// buluşamıyorlardı.
//
// Çözüm: Redis'te tek bir "waiting:public" Set'i tutuyoruz. Boş public oda
// açıldığında gameId bu Set'e ekleniyor; oda dolduğunda veya kapandığında
// kaldırılıyor. Hangi instance join isteği alırsa alsın, önce bu Set'e
// bakıyor — Redis'te kayıtlı bir oda varsa o odayı kullanıyor, yoksa yeni
// oda açıyor.

const PUBLIC_QUEUE_KEY = 'waiting:public';

/** Boş public odayı kuyruğa ekler. */
export async function enqueuePublicRoom(gameId) {
  const redis = await getRedis();
  await redis.sadd(PUBLIC_QUEUE_KEY, gameId);
}

/** Public kuyruğundan bir oda ID'si alır (varsa). Set'ten ÇIKARMAZ —
 *  caller, odanın gerçekten uygun olup olmadığını Redis'ten doğrulamalı;
 *  doluysa dequeuePublicRoom ile temizlemelidir. */
export async function peekPublicQueue() {
  const redis = await getRedis();
  const members = await redis.smembers(PUBLIC_QUEUE_KEY);
  return members.length ? members[0] : null;
}

/** Odayı public kuyruğundan çıkarır (oda dolunca veya kapanınca). */
export async function dequeuePublicRoom(gameId) {
  const redis = await getRedis();
  await redis.srem(PUBLIC_QUEUE_KEY, gameId);
}

// ─── Basit Dağıtık Kilit ──────────────────────────────────
//
// Aynı odayı iki instance'ın aynı anda düzenlemesini (ör. iki
// oyuncu tam olarak aynı anda katılırsa slot çakışması) önlemek
// için kısa ömürlü bir kilit. Kilit alınamazsa küçük bir gecikmeyle
// birkaç kez tekrar denenir.

const LOCK_KEY = (gameId) => `lock:${gameId}`;

export async function withRoomLock(gameId, fn, { ttlMs = 4000, retries = 20, retryDelayMs = 50 } = {}) {
  const redis = await getRedis();
  const token = INSTANCE_ID + ':' + Math.random().toString(36).slice(2);

  let acquired = false;
  for (let i = 0; i < retries; i++) {
    let ok;
    if (_usingStub) {
      ok = await redis.setNx(LOCK_KEY(gameId), token, ttlMs);
    } else {
      ok = await redis.set(LOCK_KEY(gameId), token, 'PX', ttlMs, 'NX');
    }
    if (ok) { acquired = true; break; }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  if (!acquired) {
    throw new Error('Oda kilidi alinamadi (yogun trafik) — tekrar deneyin.');
  }

  try {
    return await fn();
  } finally {
    if (_usingStub) {
      await redis.delIfMatch(LOCK_KEY(gameId), token);
    } else {
      // Sadece token eşleşirse sil (başka bir instance'ın kilidini yanlışlıkla silme).
      const lua = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
      await redis.eval(lua, 1, LOCK_KEY(gameId), token).catch(() => {});
    }
  }
}
