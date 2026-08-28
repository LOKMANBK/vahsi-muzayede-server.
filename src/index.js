// =========================================================
//  Vahşi Müzayede — Sunucu Giriş Noktası
//
//  HTTP sunucusu iki iş yapar:
//  1. /health → load balancer sağlık kontrolü
//  2. /stats  → oda/oyuncu sayısı (opsiyonel, debug)
//  3. WebSocket yükseltmesi (ws:// veya wss://)
// =========================================================

import { createServer } from 'http';
import { createWsServer } from './transport/wsServer.js';
import { logger }         from './utils/logger.js';

const PORT = Number(process.env.PORT ?? 8080);

// ─── HTTP sunucusu ────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  if (url.pathname === '/stats') {
    const stats = rooms?.stats() ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  res.writeHead(404);
  res.end();
});

// ─── WebSocket sunucusu ───────────────────────────────────

const { wss, rooms } = createWsServer(httpServer);

// ─── Başlat ───────────────────────────────────────────────

httpServer.listen(PORT, () => {
  logger.info('Sunucu basladi', { port: PORT, env: process.env.NODE_ENV ?? 'development' });
});

// ─── Temiz kapanış ────────────────────────────────────────

async function shutdown(signal) {
  logger.info('Kapatiliyor', { signal });
  wss.close(() => {
    httpServer.close(() => {
      logger.info('Sunucu kapandi');
      process.exit(0);
    });
  });
  // 5 saniye içinde kapanmazsa zorla kapat
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException',  (err) => logger.error('uncaughtException',  { err: err.message }));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { err: String(err) }));
