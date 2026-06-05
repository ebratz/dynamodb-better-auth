/**
 * Structured logger resolution.
 *
 * Provides a default console-based logger and a `getLogger` accessor
 * that returns the configured logger (or the default fallback). Used
 * by every module that previously called `console.warn` directly.
 */

import type { AdapterLogger, DynamoDBAdapterConfig } from "../types";

/**
 * Default logger backed by console.warn / console.debug.
 */
export const defaultLogger: AdapterLogger = {
  warn: (msg, meta) => {
    if (meta) {
      console.warn(msg, meta);
    } else {
      console.warn(msg);
    }
  },
  debug: (msg, meta) => {
    if (meta) {
      console.debug(msg, meta);
    } else {
      console.debug(msg);
    }
  },
};

/**
 * Returns the configured logger or the default console-based fallback.
 */
export function getLogger(config: Pick<DynamoDBAdapterConfig, "logger">): AdapterLogger {
  return config.logger ?? defaultLogger;
}
