import pino from 'pino';
import { loggerConfig } from '../config/logger.js';
import { readSharedEnv } from '../config/shared-env.js';

type LogMeta = Record<string, unknown>;

type AppLogger = {
  raw: pino.Logger;
  debug: (message: string, meta?: LogMeta) => void;
  info: (message: string, meta?: LogMeta) => void;
  success: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  error: (message: string, meta?: LogMeta) => void;
  child: (bindings: LogMeta) => AppLogger;
};

function buildRootLogger() {
  const env = readSharedEnv();
  const baseLoggerConfig =
    loggerConfig[env.NODE_ENV] === false ? {} : loggerConfig[env.NODE_ENV];

  return pino({
    ...baseLoggerConfig,
    name: 'app',
  });
}

function toLogPayload(meta?: LogMeta) {
  return meta ?? {};
}

function wrapLogger(logger: pino.Logger): AppLogger {
  return {
    raw: logger,
    debug(message, meta) {
      logger.debug(toLogPayload(meta), message);
    },
    info(message, meta) {
      logger.info(toLogPayload(meta), message);
    },
    success(message, meta) {
      logger.info(
        {
          ...toLogPayload(meta),
          outcome: 'success',
        },
        message,
      );
    },
    warn(message, meta) {
      logger.warn(toLogPayload(meta), message);
    },
    error(message, meta) {
      logger.error(toLogPayload(meta), message);
    },
    child(bindings) {
      return wrapLogger(logger.child(bindings));
    },
  };
}

const rootLogger = buildRootLogger();

export const appLogger = wrapLogger(rootLogger);

export function createLogger(context: string) {
  return appLogger.child({ context });
}
