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
//  Stub production'da kullanılamaz — oyun state persist olmaz.
// =========================================================

import { logger } from './logger.js';

// ─── In-Memory Stub (geliştirme ortamı) ──────────────────

class MemoryRedis {
  #store = new Map();

  async get(key)         { return this.#store.get(key) ?? null; }
  async set(key, val, ...args) {
    this.#store.set(key, val);
    // EX (expire) desteği — stub'da yok sayılır
    return 'OK';
  }
  async del(key)         { this.#store.delete(key); return 1; }
  async exists(key)      { return this.#store.has(key) ? 1 : 0; }
  async quit()           { return 'OK'; }
}

// ─── Gerçek Redis (Upstash / yerel) ──────────────────────

let _client = null;

export async function getRedis() {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('REDIS_URL yok — in-memory stub kullanılıyor (production için uygun değil)');
    _client = new MemoryRedis();
    return _client;
  }

  // ioredis — dinamik import; test ortamında mock'lanabilir
  const { default: Redis } = await import('ioredis');
  _client = new Redis(url, {
    tls:             url.startsWith('rediss://') ? {} : undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect:     true,
  });

  _client.on('error', (err) => logger.error('Redis bağlantı hatası', { err: err.message }));
  await _client.connect?.();     // ioredis v5+ için gerekebilir

  logger.info('Redis bağlandı');
  return _client;
}

// ─── Yardımcı: Oyun State CRUD ───────────────────────────

const KEY  = (gameId) => `game:${gameId}`;
const TTL  = 60 * 60 * 6;   // 6 saat — bitmemiş oyunlar için

export async function saveGameState(gameId, state) {
  const redis = await getRedis();
  await redis.set(KEY(gameId), JSON.stringify(state), 'EX', TTL);
}

export async function loadGameState(gameId) {
  const redis = await getRedis();
  const raw   = await redis.get(KEY(gameId));
  return raw ? JSON.parse(raw) : null;
}

export async function deleteGameState(gameId) {
  const redis = await getRedis();
  await redis.del(KEY(gameId));
}
