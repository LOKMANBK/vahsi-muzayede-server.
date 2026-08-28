import { WebSocketServer } from 'ws';
import { RoomManager }     from '../rooms/RoomManager.js';
import { logger }          from '../utils/logger.js';

const PING_INTERVAL_MS = 25_000;

export function createWsServer(httpServer, { reconnectMs } = {}) {
  const wss   = new WebSocketServer({ server: httpServer });
  const rooms = new RoomManager(reconnectMs);

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

async function handleMessage(ws, msg, rooms) {
  switch (msg.type) {
    case 'JOIN':
      await rooms.connect(ws, { gameId: msg.gameId, playerName: msg.playerName });
      break;
    case 'ACTION':
      if (!ws._gameId) { ws.send(JSON.stringify({ type: 'ERROR', error: 'Once JOIN gonder.' })); return; }
      await rooms.handleAction(ws, { type: msg.action?.type, payload: msg.action?.payload ?? {} });
      break;
    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG' }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Bilinmeyen tip: ' + msg.type }));
  }
}

// HTTP istek yönlendirmesi — wsServer bağımsız kullanılabilsin
export function attachHttpHandlers(httpServer, getRooms) {
  httpServer.on('request', (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    } else if (path === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRooms?.()?.stats?.() ?? {}));
    } else {
      res.writeHead(404); res.end();
    }
  });
}
