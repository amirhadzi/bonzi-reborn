// Small main-process logger: console plus userData/logs/main.log (capped,
// rotated once). Never pass secrets or user message text at info level; as a
// second line of defence, known secrets and key-shaped strings are redacted.

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 1024 * 1024;

let logFile: string | null = null;
let logSize = 0;
let minLevel: LogLevel = 'info';
const secrets = new Set<string>();

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Initialises file logging in the given directory. Safe to call once after userData is known. */
export function initFileLogging(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    try {
      logSize = fs.statSync(logFile).size;
    } catch {
      logSize = 0;
    }
  } catch {
    logFile = null;
  }
}

/** Registers a value (e.g. the current API key) that must never appear in logs. */
export function addRedaction(value: string | null): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function removeRedaction(value: string | null): void {
  if (value) secrets.delete(value);
}

export function redactSecrets(message: string): string {
  let out = message;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out
    .replace(/\b(sk-[A-Za-z0-9]{0,4})[A-Za-z0-9_-]{12,}/g, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

function rotateIfNeeded(file: string, incoming: number): void {
  if (logSize + incoming <= MAX_LOG_BYTES) return;
  try {
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // If rotation fails, truncate instead so the log never grows unbounded.
    try {
      fs.writeFileSync(file, '');
    } catch {
      // ignore
    }
  }
  logSize = 0;
}

function write(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} [${level}] ${redactSecrets(message)}`;
  const consoleFn = level === 'debug' ? console.log : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  consoleFn(line);
  if (!logFile) return;
  const data = line + '\n';
  const bytes = Buffer.byteLength(data);
  try {
    rotateIfNeeded(logFile, bytes);
    fs.appendFileSync(logFile, data);
    logSize += bytes;
  } catch {
    // Logging must never crash the app.
  }
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const log: Logger = {
  debug: (m) => write('debug', m),
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
