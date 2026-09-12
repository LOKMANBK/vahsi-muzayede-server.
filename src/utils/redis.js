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
// Çözüm: Redis'te oyuncu sayısına göre AYRI birer "waiting:public:N" Set'i
// tutuyoruz (N=2 veya 3). Boş public oda açıldığında gameId kendi modunun
// Set'ine ekleniyor; oda dolduğunda veya kapandığında kaldırılıyor. Hangi
// instance join isteği alırsa alsın, önce KENDİ istediği playerCount'un
// Set'ine bakıyor — Redis'te kayıtlı bir oda varsa o odayı kullanıyor, yoksa
// yeni oda açıyor.
//
// NOT (önceki tasarım hatası): Daha önce TEK bir "waiting:public" Set'i
// vardı ve 2 kişilik ile 3 kişilik odalar aynı kuyrukta karışıyordu.
// peekPublicQueue() kuyruktaki yalnızca TEK bir adaya bakıyordu — o aday
// yanlış moddaysa (WRONG_MODE) kuyrukta bırakılıp isteyen kendi başına yeni
// bir oda açıyordu, ama kuyruktaki diğer (doğru modda olabilecek) adaylar
// hiç denenmiyordu. Sonuç: iki mod karışık kullanıldığında (ör. biri
// "Rastgele Oyna", biri "3 Kişilik Rastgele" bastığında) eşleşme oranı
// neredeyse sıfıra düşüyordu — hatta modlardan biri hiç kullanılmasa bile
// kuyrukta unutulmuş eski bir oda bir sonraki tüm eşleşmeleri bloke
// edebiliyordu. Modlara göre ayrı Set kullanmak bu sınıf hatayı komple
// ortadan kaldırır.

const PUBLIC_QUEUE_KEY = (playerCount) => `waiting:public:${playerCount === 3 ? 3 : 2}`;

// ── Kuyruk üyesi formatı: "GAMEID|enqueuedAtMs" ───────────
//
// NEDEN? Redis Set üyelerine tek tek TTL verilemez. Kuyruğa eklenen bir oda,
// herhangi bir kod yolu dequeue'yu atlarsa (process crash, deploy kesintisi,
// beklenmedik exception) Set'te SONSUZA KADAR kalır. Oda kaydının kendisi ise
// TTL ile düşer → kuyrukta "ölü" bir gameId birikir ve peek her seferinde onu
// döndürdüğü için o mod tamamen kilitlenir (bkz. "Oda bulunamadi: KT1OIK"
// prod hatası — 3 kişilik rastgele mod komple çalışmaz hâle gelmişti).
//
// Çözüm: eklenme zamanını üyenin İÇİNE gömüyoruz. Tarama sırasında yaşı
// MAX_QUEUE_AGE_MS'i aşan üyeler oda kaydına hiç bakılmadan temizlenir —
// kuyruk kendi kendini onarır.
//
// Geriye dönük uyum: "|" içermeyen eski üyeler yaşı bilinmeyen kabul edilir,
// atılmaz; nasılsa oda doğrulamasında ölüyse temizlenecekler.

const QUEUE_SEP        = '|';
const MAX_QUEUE_AGE_MS = 10 * 60 * 1000; // 10 dk — bu yaştan eski kayıt bayattır

function encodeQueueMember(gameId) {
  return `${gameId}${QUEUE_SEP}${Date.now()}`;
}

function decodeQueueMember(member) {
  const idx = member.indexOf(QUEUE_SEP);
  if (idx === -1) return { gameId: member, enqueuedAt: null };
  return {
    gameId:     member.slice(0, idx),
    enqueuedAt: Number(member.slice(idx + 1)) || null,
  };
}

/** Boş public odayı kendi playerCount'unun kuyruğuna ekler. */
export async function enqueuePublicRoom(gameId, playerCount = 2) {
  const redis = await getRedis();
  // Aynı oda için eski bir kayıt varsa önce temizle (çift kayıt olmasın).
  await dequeuePublicRoom(gameId, playerCount);
  await redis.sadd(PUBLIC_QUEUE_KEY(playerCount), encodeQueueMember(gameId));
}

/**
 * Kuyruktaki TÜM aday oda ID'lerini (en eskiden yeniye) döndürür.
 *
 * Yaşı MAX_QUEUE_AGE_MS'i aşan üyeler dönmeden önce kuyruktan silinir.
 * Caller her adayı sırayla denemeli; uygun olmayanı dequeuePublicRoom ile
 * temizleyip bir SONRAKİ adaya geçmelidir — tek adayda durmamalıdır.
 */
export async function listPublicQueue(playerCount = 2) {
  const redis   = await getRedis();
  const members = await redis.smembers(PUBLIC_QUEUE_KEY(playerCount));
  const now     = Date.now();
  const alive   = [];

  for (const member of members) {
    const { gameId, enqueuedAt } = decodeQueueMember(member);
    if (enqueuedAt !== null && now - enqueuedAt > MAX_QUEUE_AGE_MS) {
      await redis.srem(PUBLIC_QUEUE_KEY(playerCount), member).catch(() => {});
      logger.info('Bayat kuyruk kaydi temizlendi', { gameId, playerCount, ageMs: now - enqueuedAt });
      continue;
    }
    alive.push({ gameId, enqueuedAt: enqueuedAt ?? 0 });
  }

  // En uzun bekleyen önce eşleşsin (adil sıra).
  alive.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return alive.map((x) => x.gameId);
}

/**
 * Public kuyruğundan tek bir aday döndürür.
 * @deprecated listPublicQueue kullanın — bu fonksiyon yalnızca ilk adaya
 * bakar; o aday ölüyse kuyruktaki diğer (sağlam) odalar hiç denenmez.
 */
export async function peekPublicQueue(playerCount = 2) {
  const ids = await listPublicQueue(playerCount);
  return ids.length ? ids[0] : null;
}

/** Odayı public kuyruğundan çıkarır (oda dolunca veya kapanınca). */
export async function dequeuePublicRoom(gameId, playerCount = 2) {
  const redis   = await getRedis();
  const key     = PUBLIC_QUEUE_KEY(playerCount);
  // Üye artık "GAMEID|ts" formatında olduğu için doğrudan srem(gameId) yetmez;
  // gameId'si eşleşen tüm üyeleri (eski formatlı kayıtlar dahil) siliyoruz.
  const members = await redis.smembers(key);
  const targets = members.filter((m) => decodeQueueMember(m).gameId === gameId);
  if (targets.length) await redis.srem(key, ...targets);
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
