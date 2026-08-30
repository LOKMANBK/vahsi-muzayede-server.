import { WebSocketServer } from 'ws';
import { RoomManager }     from '../rooms/RoomManager.js';
import { logger }          from '../utils/logger.js';

// ÖNEMLİ: Bazı proxy/hosting katmanları (Railway dahil), üzerinden veri
// geçmeyen WebSocket bağlantılarını sunucunun ilk ping'i atmasından ÇOK
// ÖNCE (gözlemlenen: ~20 sn sessizlikte) kapatabiliyor. Eskiden bu değer
// 25 sn idi — lobide (arkadaş kodu / düello daveti bekleerken) hiç veri
// akmadığından bağlantı sunucu ilk ping'i atmadan kesiliyor, bu da
// "Waiting oda kaldirildi" ile birleşince davet kodunun anında ölü
// görünmesine yol açıyordu. Aralığı kısaltıp bağlantı açılır açılmaz da
// bir ilk ping atarak boşta kalan soketleri canlı tutuyoruz.
const PING_INTERVAL_MS = 10_000;

export function createWsServer(httpServer, { reconnectMs, lobbyCountdownMs, autoDelays, battleNextDelayMs } = {}) {
  const wss   = new WebSocketServer({ server: httpServer });
  const rooms = new RoomManager({ reconnectMs, lobbyCountdownMs, autoDelays, battleNextDelayMs });

  const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._alive) { ws.terminate(); return; }
      ws._alive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingTimer));

  wss.on('connection', (ws) => {
    ws._alive = true;
    // İlk ping'i döngünün ilk turunu (10 sn) beklemeden, hemen atıyoruz —
    // böylece lobide oturan bir bağlantı en baştan itibaren "boşta" sayılıp
    // aradaki bir proxy tarafından erken kesilmiyor.
    setTimeout(() => {
      if (ws.readyState === 1) { ws._alive = false; ws.ping(); }
    }, 3_000);
    ws.on('pong', () => { ws._alive = true; });
    ws.on('message', async (raw) => {
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
    ws.on('error', (err) => logger.error('WS soket hatasi', { err: err.message }));
  });

  logger.info('WebSocket sunucusu hazir');
  return { wss, rooms };
}

// ── Input Doğrulama Yardımcıları ─────────────────────────

/** Güvenli string — null byte, kontrol karakteri, aşırı uzun değer temizler. */
function safeStr(val, maxLen = 64) {
  if (val == null) return null;
  return String(val).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen) || null;
}

/** gameId formatı: 4-12 harf/rakam */
function validGameId(val) {
  if (!val) return null;
  const s = String(val).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return s.length >= 4 ? s : null;
}

/** reconnectToken formatı: tam 64 hex karakter */
function validToken(val) {
  if (!val) return null;
  const s = String(val);
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

async function handleMessage(ws, msg, rooms) {
  switch (msg.type) {
    case 'JOIN': {
      const playerName    = safeStr(msg.playerName, 32) || 'Oyuncu';
      const gameId        = validGameId(msg.gameId);
      const reconnectToken = validToken(msg.reconnectToken);
      const userId        = safeStr(msg.userId, 64);

      await rooms.connect(ws, {
        gameId,
        playerName,
        privateLobby:   !!msg.privateLobby,
        userId,
        reconnectToken,
      });
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
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Bilinmeyen tip: ' + msg.type }));
  }
}

export function attachHttpHandlers(httpServer, getRooms) {
  const STATS_TOKEN = process.env.STATS_TOKEN;

  httpServer.on('request', (req, res) => {
    const url  = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));

    } else if (path === '/stats') {
      // STATS_TOKEN env varı tanımlıysa Bearer token kontrolü yap
      if (STATS_TOKEN) {
        const auth = req.headers['authorization'] ?? '';
        if (auth !== `Bearer ${STATS_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRooms?.()?.stats?.() ?? {}));

    } else {
      res.writeHead(404); res.end();
    }
  });
}
