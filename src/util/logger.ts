/**
 * Structured logging for UCU-MCP.
 *
 * Pino-compatible interface built on console — no external dependency.
 * Each log entry is a JSON line with level, timestamp, name, and
 * optional correlationId plus arbitrary structured fields.
 *
 * Usage:
 *   import { createLogger } from "../util/logger.js";
 *   const log = createLogger("tools");
 *   log.info("Tool executed", { tool: "click", duration: 42 });
 *   log.error("Tool failed", { error: "boom" });
 *
 * Correlation IDs are scoped per-logger via `withCorrelationId`:
 *   const log = createLogger("safety").withCorrelationId("req-123");
 *   log.info("check passed");  // → { ..., correlationId: "req-123" }
 */

// ── Types ──────────────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  [key: string]: unknown;
}

interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  withCorrelationId(id: string): Logger;
}

// ── Level precedence ──────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const env = process.env.UCU_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

const MIN_LEVEL = LEVEL_ORDER[resolveMinLevel()];

// ── JSON formatting ───────────────────────────────────────────────────────

function formatEntry(
  level: LogLevel,
  name: string,
  message: string,
  correlationId: string | undefined,
  fields: LogFields | undefined,
): string {
  const entry: Record<string, unknown> = {
    level,
    time: Date.now(),
    timestamp: new Date().toISOString(),
    name,
    msg: message,
  };
  if (correlationId) entry.correlationId = correlationId;
  if (fields) Object.assign(entry, fields);
  return JSON.stringify(entry);
}

// ── Logger implementation ─────────────────────────────────────────────────

class ConsoleLogger implements Logger {
  private readonly _name: string;
  private readonly _correlationId: string | undefined;

  constructor(name: string, correlationId?: string) {
    this._name = name;
    this._correlationId = correlationId;
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < MIN_LEVEL) return;
    // Write to stderr so stdout stays clean for MCP transport
    console.error(formatEntry(level, this._name, message, this._correlationId, fields));
  }

  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  withCorrelationId(id: string): Logger {
    return new ConsoleLogger(this._name, id);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Create a named logger instance.
 *
 * @param name - Module / subsystem name (included in every log entry)
 * @returns Logger with info, warn, error, debug, and withCorrelationId
 */
function createLogger(name: string): Logger {
  return new ConsoleLogger(name);
}

/**
 * Default root logger for backward compatibility.
 * Prefer `createLogger("module")` for new code.
 */
const logger = createLogger("ucu-mcp");

export { createLogger, logger };
export type { Logger, LogFields };
