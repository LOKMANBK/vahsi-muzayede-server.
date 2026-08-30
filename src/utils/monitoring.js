// =========================================================
//  monitoring.js — Crash Reporting (Sentry) + Analytics (PostHog)
//
//  Kullanım:
//    import { initMonitoring, capture, setTag } from './utils/monitoring.js';
//    initMonitoring();                             // index.js'te ilk satır
//    capture('game_started', { gameId, mode });   // event gönder
//
//  Her iki servis de opsiyoneldir:
//    SENTRY_DSN     boşsa → Sentry devre dışı
//    POSTHOG_KEY    boşsa → PostHog devre dışı
// =========================================================

import { logger } from './logger.js';

// ── Sentry ───────────────────────────────────────────────

let Sentry = null;

/**
 * Sentry'yi başlatır. SENTRY_DSN env varı yoksa sessizce atlar.
 * index.js'in ilk satırlarında çağrılmalı (diğer import'lardan önce).
 */
export async function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry devre disi (SENTRY_DSN tanimlanmamis)');
    return;
  }
  try {
    const mod = await import('@sentry/node');
    Sentry = mod;
    Sentry.init({
      dsn,
      environment:       process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      tracesSampleRate:  Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
      // Node.js'te uncaughtException ve unhandledRejection otomatik yakalanır.
      // Ayrıca process.on() listener'larıyla çakışmasın diye integrations'ı özelleştiriyoruz.
      integrations: (defaults) =>
        defaults.filter(
          (i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'
        ),
    });
    logger.info('Sentry baslatildi', { environment: Sentry.getClient()?.getOptions()?.environment });
  } catch (err) {
    logger.warn('Sentry baslatma hatasi (paket yuklu degil?)', { err: err.message });
  }
}

/**
 * Bir hatayı Sentry'ye bildirir.
 * @param {Error|unknown} err
 * @param {Record<string,any>} [context]  — ek etiketler / extra bilgi
 */
export function reportError(err, context = {}) {
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
  });
}

/**
 * Sentry'ye bir bilgi mesajı (breadcrumb) ekler.
 * Hata olmayan ama izlenmesi gereken önemli olaylar için kullanılır.
 */
export function addBreadcrumb(message, data = {}) {
  if (!Sentry) return;
  Sentry.addBreadcrumb({ message, data, level: 'info' });
}

// ── PostHog ──────────────────────────────────────────────

let posthog = null;

/**
 * PostHog Node.js client'ını başlatır.
 * POSTHOG_KEY env varı yoksa sessizce atlar.
 */
export async function initPostHog() {
  const key  = process.env.POSTHOG_KEY;
  const host = process.env.POSTHOG_HOST ?? 'https://eu.posthog.com';
  if (!key) {
    logger.info('PostHog devre disi (POSTHOG_KEY tanimlanmamis)');
    return;
  }
  try {
    const { PostHog } = await import('posthog-node');
    posthog = new PostHog(key, {
      host,
      // Server-side'da flush periyodu: her 10sn'de bir toplu gönderim.
      flushAt:       20,
      flushInterval: 10_000,
      // Geliştirme ortamında event'leri gerçekten gönderme.
      disabled: process.env.NODE_ENV !== 'production',
    });
    logger.info('PostHog baslatildi', { host });
  } catch (err) {
    logger.warn('PostHog baslatma hatasi (paket yuklu degil?)', { err: err.message });
  }
}

/**
 * PostHog'a bir event gönderir.
 *
 * distinctId olarak sunucu instance ID'si veya 'server' kullanılır —
 * server-side eventlerde kullanıcı ID'si genellikle bilinmez.
 * Kullanıcıya özel eventler için distinctId olarak userId verin.
 *
 * @param {string} event            — event adı (snake_case önerilir)
 * @param {Record<string,any>} props — event özellikleri
 * @param {string} [distinctId]     — kullanıcı ID'si (yoksa 'server')
 */
export function capture(event, props = {}, distinctId = 'server') {
  if (!posthog) return;
  try {
    posthog.capture({ distinctId, event, properties: { ...props, $lib: 'vahsi-muzayede-server' } });
  } catch (err) {
    logger.debug('PostHog capture hatasi', { err: err.message });
  }
}

/**
 * Uygulama kapanırken PostHog queue'sunu flush et — event kaybı önlenir.
 */
export async function shutdownMonitoring() {
  try { await posthog?.shutdown(); } catch {}
  try { await Sentry?.close(2000); } catch {}
}

// ── İkisi birden ─────────────────────────────────────────

/** Hem Sentry hem PostHog'u başlat. index.js'in ilk işi olmalı. */
export async function initMonitoring() {
  await Promise.all([initSentry(), initPostHog()]);
}
