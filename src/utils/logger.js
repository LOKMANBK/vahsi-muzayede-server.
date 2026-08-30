// ─── Logger ───────────────────────────────────────────────
// JSON formatı — Railway/Render log aggregator'ları için.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN    = LEVELS[process.env.LOG_LEVEL ?? 'info'];

function log(level, msg, data = {}) {
  if (LEVELS[level] < MIN) return;
  const line = { ts: new Date().toISOString(), level, msg, ...data };
  const out  = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg, d) => log('debug', msg, d),
  info:  (msg, d) => log('info',  msg, d),
  warn:  (msg, d) => log('warn',  msg, d),
  error: (msg, d) => log('error', msg, d),
};
