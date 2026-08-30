// =========================================================
//  wsServer.js — WebSocket Sunucusu
//
//  Rate Limiting Katmanları:
//  1. IP bazlı bağlantı hız sınırı (DDoS koruması)
//     → Aynı IP'den kısa sürede çok bağlantı gelirse reddedilir.
//  2. Bağlantı başına ACTION rate limit (RoomManager'da da var)
//     → Saniyede MAX_ACTION_PER_WS action.
//  3. JOIN rate limit (her bağlantı yalnızca bir kez JOIN gönderebilir)
// =========================================================

import { WebSocketServer } from 'ws';
import { RoomManager }     from '../rooms/RoomManager.js';
import { logger }          from '../utils/logger.js';

const PING_INTERVAL_MS = 10_000;

// ── IP Bazlı Bağlantı Rate Limit ─────────────────────────
//
// Aynı IP'den CONN_LIMIT_WINDOW_MS içinde CONN_LIMIT_MAX'ten fazla
// bağlantı gelirse yeni bağlantılar anında kapatılır ve loglanır.
// Railway/Render gibi proxy arkasındaki ortamlarda gerçek IP için
// x-forwarded-for başlığı kullanılır.
//
// Boyut: Map her entry ~100B, 10k IP = ~1MB — kabul edilebilir.

const CONN_LIMIT_MAX        = 20;    // N bağlantı
const CONN_LIMIT_WINDOW_MS  = 10_000; // 10 saniye içinde
const ipConnMap = new Map();         // ip → { count, resetAt }

/** IP'nin son CONN_LIMIT_WINDOW_MS içindeki bağlantı sayısını kontrol eder. */
function checkIpRateLimit(ip) {
  const now = Date.now();
  let entry = ipConnMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + CONN_LIMIT_WINDOW_MS };
    ipConnMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= CONN_LIMIT_MAX;
}

/** Periyodik temizlik — stale IP entry'lerini temizle (memory leak önlemi). */
function startIpMapCleanup() {
  return setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipConnMap) {
      if (now > entry.resetAt) ipConnMap.delete(ip);
    }
  }, 60_000); // 1 dakikada bir
}

/** Proxy arkasındaki gerçek IP'yi al. */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

// ── WebSocket Sunucu Fabrikası ────────────────────────────

export function createWsServer(httpServer, {
  reconnectMs,
  lobbyCountdownMs,
  autoDelays,
  battleNextDelayMs,
  bidTimeoutMs,
} = {}) {
  const wss   = new WebSocketServer({ server: httpServer });
  const rooms = new RoomManager({
    reconnectMs,
    lobbyCountdownMs,
    autoDelays,
    battleNextDelayMs,
    bidTimeoutMs,
  });

  const pingTimer    = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._alive) { ws.terminate(); return; }
      ws._alive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  const ipCleanTimer = startIpMapCleanup();

  wss.on('close', () => {
    clearInterval(pingTimer);
    clearInterval(ipCleanTimer);
  });

  wss.on('connection', (ws, req) => {
    const clientIp = getClientIp(req);

    // ── IP bağlantı rate limit ──────────────────────────
    if (!checkIpRateLimit(clientIp)) {
      logger.warn('IP rate limit: baglanti reddedildi', { ip: clientIp });
      ws.close(1008, 'Rate limited');
      return;
    }

    ws._alive       = true;
    ws._clientIp    = clientIp;
    ws._joinedAt    = null;    // JOIN sonrası set edilir
    ws._joinCount   = 0;       // Bir bağlantı yalnızca 1 kez JOIN gönderebilir

    // İlk ping'i hemen at (proxy timeout koruması)
    setTimeout(() => {
      if (ws.readyState === 1) { ws._alive = false; ws.ping(); }
    }, 3_000);

    ws.on('pong', () => { ws._alive = true; });

    ws.on('message', async (raw) => {
      // Ham mesaj boyutu sınırı: 4 KB'ı aşan mesajlar hemen reddedilir.
      // Normal oyun mesajları < 500B; büyük mesajlar saldırı işareti.
      if (raw.length > 4096) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Mesaj cok buyuk.' }));
        logger.warn('Asiri buyuk WS mesaji', { ip: clientIp, bytes: raw.length });
        return;
      }

      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { ws.send(JSON.stringify({ type: 'ERROR', error: 'Gecersiz JSON.' })); return; }

      try { await handleMessage(ws, msg, rooms); }
      catch (err) {
        logger.error('Mesaj isleme hatasi', { err: err.message });
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Sunucu hatasi.' }));
      }
    });

    ws.on('close', () => rooms.disconnect(ws));
    ws.on('error', (err) => logger.error('WS soket hatasi', { ip: clientIp, err: err.message }));
  });

  logger.info('WebSocket sunucusu hazir');
  return { wss, rooms };
}

// ── Input Doğrulama ───────────────────────────────────────

function safeStr(val, maxLen = 64) {
  if (val == null) return null;
  return String(val).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen) || null;
}

function validGameId(val) {
  if (!val) return null;
  const s = String(val).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return s.length >= 4 ? s : null;
}

function validToken(val) {
  if (!val) return null;
  const s = String(val);
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

// ── Mesaj İşleyici ────────────────────────────────────────

async function handleMessage(ws, msg, rooms) {
  switch (msg.type) {

    case 'JOIN': {
      // Bir bağlantı yalnızca 1 kez JOIN gönderebilir.
      // Birden fazla JOIN: hatalı istemci veya saldırı — reddet.
      ws._joinCount = (ws._joinCount ?? 0) + 1;
      if (ws._joinCount > 1) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Zaten bir odadasiniz.' }));
        logger.warn('Tekrarlı JOIN girişimi', { ip: ws._clientIp, gameId: ws._gameId });
        return;
      }

      const playerName     = safeStr(msg.playerName, 32) || 'Oyuncu';
      const gameId         = validGameId(msg.gameId);
      const reconnectToken = validToken(msg.reconnectToken);
      const userId         = safeStr(msg.userId, 64);

      await rooms.connect(ws, {
        gameId,
        playerName,
        privateLobby: !!msg.privateLobby,
        userId,
        reconnectToken,
      });
      ws._joinedAt = Date.now();
      break;
    }

    case 'ACTION':
      if (!ws._gameId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Once JOIN gonder.' }));
        return;
      }
      await rooms.handleAction(ws, {
        type:    msg.action?.type,
        payload: msg.action?.payload ?? {},
      });
      break;

    case 'READY':
      if (!ws._gameId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Once JOIN gonder.' }));
        return;
      }
      await rooms.handleReady(ws);
      break;

    case 'REMATCH_REQUEST':
      if (!ws._gameId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Once JOIN gonder.' }));
        return;
      }
      await rooms.requestRematch(ws);
      break;

    case 'REMATCH_RESPONSE':
      if (!ws._gameId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Once JOIN gonder.' }));
        return;
      }
      await rooms.respondRematch(ws, !!msg.accepted);
      break;

    case 'LEAVE_FINAL':
      if (!ws._gameId) return;
      await rooms.leaveFinal(ws);
      break;

    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Bilinmeyen tip: ' + String(msg.type).slice(0, 32) }));
  }
}

// ── HTTP Handler (test ve production için) ────────────────

export function attachHttpHandlers(httpServer, getRooms) {
  const STATS_TOKEN = process.env.STATS_TOKEN;

  httpServer.on('request', (req, res) => {
    const url  = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }

    if (STATS_TOKEN) {
      const auth = req.headers['authorization'] ?? '';
      if (['/stats', '/metrics'].includes(path) && auth !== `Bearer ${STATS_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (path === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRooms?.()?.stats?.() ?? {}));
      return;
    }

    res.writeHead(404); res.end();
  });
}
