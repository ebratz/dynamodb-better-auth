/**
 * Lightweight metrics wrapper for adapter operations.
 *
 * Wraps any async function with start/end timing and fires the configured
 * AdapterMetrics callback with operation name, model, duration (ms), and
 * optional error.
 *
 * Used by factory.ts to instrument all 9 native methods.
 */

import type { AdapterMetrics } from "../types";

/**
 * Wraps an async call with timing instrumentation.
 *
 * - Records start time before calling `fn`.
 * - Records end time after resolution/rejection.
 * - Calls `metrics({ operation, model, durationMs, error? })`.
 * - Re-throws on error (after metrics call).
 *
 * If `metrics` is undefined, `fn` is called directly (zero overhead).
 */
export async function measureLatency<T>(
  metrics: AdapterMetrics | undefined,
  operation: string,
  model: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!metrics) return fn();

  const start = Date.now();
  let failure: Error | undefined;
  try {
    return await fn();
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    try {
      metrics({ operation, model, durationMs: Date.now() - start, ...(failure ? { error: failure } : {}) });
    } catch {
      // Instrumentation must not change a committed write or mask its error.
    }
  }
}
