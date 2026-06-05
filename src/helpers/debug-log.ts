/**
 * Debug-log guard helper.
 *
 * Eliminates the copy-pasted pattern:
 *   if (config.debugLogs) {
 *     const debug = typeof config.debugLogs === 'object' ? config.debugLogs : {};
 *     if (debug.operation !== false) { console.warn(...); }
 *   }
 *
 * Usage: `if (shouldLog(config, "update")) { console.warn(...); }`
 *
 * - `config.debugLogs` is `true`       → log all operations
 * - `config.debugLogs` is `false`/unset → log nothing
 * - `config.debugLogs` is a Record      → log only if key[operation] !== false
 */

export function shouldLog(
  config: { debugLogs?: boolean | Record<string, boolean> },
  operation: string,
): boolean {
  if (!config.debugLogs) return false;
  if (typeof config.debugLogs === "object") {
    return config.debugLogs[operation] !== false;
  }
  return true; // boolean true
}
