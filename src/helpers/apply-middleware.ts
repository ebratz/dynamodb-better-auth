/**
 * Middleware application helper.
 *
 * Wraps an adapter method with before/after hooks from configured extensions.
 * Each extension implements DynamoAdapterMiddleware; hooks are optional and
 * run sequentially in array order.
 *
 * Before-hooks: receive the original args, may return a partial args object
 * that gets shallow-merged into the args before calling the original function.
 * This enables multi-tenancy (add tenantId to data), soft-delete (add
 * isDeleted = false to where), etc.
 *
 * After-hooks: receive original args + result for audit logging.
 */

import type { DynamoAdapterMiddleware } from "../types";

/**
 * Wraps an adapter method with middleware hooks.
 *
 * @param extensions - Configured middleware (config.extensions)
 * @param operation  - PascalCase operation name (e.g. "Create", "Update")
 * @param fn         - Original adapter method to wrap
 * @returns Wrapped method that calls before hooks → fn → after hooks
 */
export function applyMiddleware(
  extensions: DynamoAdapterMiddleware[],
  operation: string,
  fn: (args: any) => Promise<any>,
): (args: any) => Promise<any> {
  if (!extensions || extensions.length === 0) return fn;

  const beforeKey = `onBefore${operation}` as keyof DynamoAdapterMiddleware;
  const afterKey = `onAfter${operation}` as keyof DynamoAdapterMiddleware;

  const beforeHooks = extensions
    .map((e) => e[beforeKey] as ((args: any) => any) | undefined)
    .filter((h): h is NonNullable<typeof h> => typeof h === "function");

  const afterHooks = extensions
    .map((e) => e[afterKey] as ((args: any) => any) | undefined)
    .filter((h): h is NonNullable<typeof h> => typeof h === "function");

  if (beforeHooks.length === 0 && afterHooks.length === 0) {
    return fn;
  }

  return async (args: any) => {
    let modifiedArgs = { ...args };

    // Run before hooks sequentially — each may return a partial
    // args object to merge (e.g., { data: enrichedData })
    for (const hook of beforeHooks) {
      const patch = await hook(args);
      if (patch && typeof patch === "object") {
        modifiedArgs = { ...modifiedArgs, ...patch };
      }
    }

    // Run the original function with potentially modified args
    const result = await fn(modifiedArgs);

    // Run after hooks with original args (not modified) + result
    for (const hook of afterHooks) {
      await hook({ ...args, result });
    }

    return result;
  };
}

/**
 * Runs transaction-level hooks around a flush callback.
 *
 * @param extensions - Configured middleware
 * @param operations  - Number of buffered operations
 * @param flushFn     - Async function that performs the flush
 * @returns Result of flushFn
 */
export async function runTransactionMiddleware(
  extensions: DynamoAdapterMiddleware[],
  operations: number,
  flushFn: () => Promise<unknown>,
): Promise<unknown> {
  if (!extensions || extensions.length === 0) return flushFn();

  // Before hooks
  for (const ext of extensions) {
    if (ext.onBeforeTransaction) {
      await ext.onBeforeTransaction({ operations });
    }
  }

  // Flush
  const result = await flushFn();

  // After hooks
  for (const ext of extensions) {
    if (ext.onAfterTransaction) {
      await ext.onAfterTransaction({ operations, result });
    }
  }

  return result;
}
