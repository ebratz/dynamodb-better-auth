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
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    metrics({ operation, model, durationMs });
    return result;
  } catch (err: any) {
    const durationMs = Date.now() - start;
    metrics({ operation, model, durationMs, error: err });
    throw err;
  }
}
