// =========================================================
//  Vahşi Müzayede — Sunucu Giriş Noktası
//
//  HTTP sunucusu:
//  1. /health   → load balancer sağlık kontrolü
//  2. /stats    → oda/oyuncu sayısı (token korumalı)
//  3. /metrics  → process + oyun metrikleri (token korumalı)
//  4. WebSocket yükseltmesi (ws:// veya wss://)
// =========================================================

// ÖNEMLİ: Sentry initMonitoring() diğer import'lardan ÖNCE çağrılmalı.
// Aksi hâlde Sentry bazı otomatik instrumentationları kaçırır.
import { initMonitoring, reportError, shutdownMonitoring } from './utils/monitoring.js';
await initMonitoring();

import { createServer }     from 'http';
import { createWsServer }   from './transport/wsServer.js';
import { logger }           from './utils/logger.js';

const PORT    = Number(process.env.PORT ?? 8080);
const START_T = Date.now();

// ─── HTTP sunucusu ────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now(), uptimeMs: Date.now() - START_T }));
    return;
  }

  // STATS_TOKEN varsa her iki korunan endpoint için kontrol et
  const statsToken = process.env.STATS_TOKEN;
  if (statsToken && ['/stats', '/metrics'].includes(url.pathname)) {
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${statsToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  if (url.pathname === '/stats') {
    const stats = rooms?.stats() ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  if (url.pathname === '/metrics') {
    // Process metrikleri — Railway, Render, Datadog, Grafana gibi araçlar için
    const mem  = process.memoryUsage();
    const load = process.cpuUsage();
    const gameStats = rooms?.stats() ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ts:          Date.now(),
      uptimeMs:    Date.now() - START_T,
      pid:         process.pid,
      nodeVersion: process.version,
      memory: {
        rss:        mem.rss,
        heapUsed:   mem.heapUsed,
        heapTotal:  mem.heapTotal,
        external:   mem.external,
      },
      cpu: {
        userMs:   Math.round(load.user   / 1000),
        systemMs: Math.round(load.system / 1000),
      },
      // WebSocket bağlantı sayısı
      wsConnections: wss?.clients?.size ?? 0,
      // Oyun odaları
      ...gameStats,
    }));
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
  // Monitoring flush — event kaybı önlenir
  await shutdownMonitoring().catch(() => {});
  wss.close(() => {
    httpServer.close(() => {
      logger.info('Sunucu kapandi');
      process.exit(0);
    });
  });
  // 10 saniye içinde kapanmazsa zorla kapat
  // (5sn → 10sn: monitoring flush + aktif bağlantılar için ek süre)
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// uncaughtException ve unhandledRejection — hem Sentry'ye bildir hem logla
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err.message, stack: err.stack?.slice(0, 500) });
  reportError(err, { type: 'uncaughtException' });
  // Kısa bir flush süresi ver, sonra zorla çık (process corrupt olabilir)
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('unhandledRejection', { err: err.message });
  reportError(err, { type: 'unhandledRejection' });
});
