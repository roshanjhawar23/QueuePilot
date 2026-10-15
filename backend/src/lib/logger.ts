/**
 * Structured JSON logging. Every line is a JSON object so CloudWatch Logs Insights can filter
 * by fields, e.g.:  fields @timestamp, level, msg | filter jobId = "..." | sort @timestamp
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function serializeError(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 5).join('\n') };
  return v;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, extra?: Record<string, unknown>) => {
    if (level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra ?? {})) fields[k] = serializeError(v);
    const line = JSON.stringify({ level, msg, ...context, ...fields, ts: new Date().toISOString() });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    child: (c) => createLogger({ ...context, ...c }),
  };
}

export const logger = createLogger({ service: 'queuepilot' });
